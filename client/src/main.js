import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { history as undoHistory, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { LanguageSupport } from '@codemirror/language'
import { markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { livePreview } from './livepreview.js'
import { Hub } from './hub.js'
import { DocSync } from './sync.js'

const $ = s => document.querySelector(s)
const ID = /^\/([A-Za-z0-9]{8,32})$/

function randomId(n) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  while (s.length < n) for (const b of crypto.getRandomValues(new Uint8Array(n))) if (b < 248 && s.length < n) s += abc[b % 62]
  return s
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

// ---------- recent documents (this browser only) ----------

let docs = store.get('docs', [])  // [{ id, title, at }]
let current = null

function titleOf(md) {
  for (const raw of md.split('\n')) {
    const line = raw.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1').trim().replace(/^[#>\-*+ ]+/, '').trim()
    if (line) return line.slice(0, 80)
  }
  return ''
}

function remember(id, title, touch) {
  let d = docs.find(d => d.id === id)
  if (!d) docs.push(d = { id, title: '', at: 0 })
  if (title != null) d.title = title
  if (touch) d.at = Date.now()
  store.set('docs', docs)
  renderList()
}

function renderList() {
  const list = $('#list')
  list.textContent = ''
  const shown = docs.some(d => d.id === current) ? docs : [...docs, { id: current, title: '', at: Infinity }]
  for (const d of [...shown].sort((a, b) => b.at - a.at)) {
    const a = document.createElement('a')
    a.href = '/' + d.id
    a.className = d.id === current ? 'on' : ''
    a.textContent = d.title || 'Untitled'
    const x = document.createElement('button')
    x.className = 'x'
    x.title = 'Remove from list'
    x.textContent = '×'
    x.onclick = e => {
      e.preventDefault()
      docs = docs.filter(o => o.id !== d.id)
      store.set('docs', docs)
      if (d.id === current) go(randomId(12))
      else renderList()
    }
    a.append(x)
    list.append(a)
  }
}

async function refreshTitles() {
  const ids = docs.filter(d => d.id !== current).map(d => d.id)
  if (!ids.length) return
  try {
    const titles = await (await fetch('/api/titles?ids=' + ids.join(','))).json()
    for (const d of docs) if (titles[d.id]) d.title = titles[d.id]
    store.set('docs', docs)
    renderList()
  } catch {}
}

// Linked documents show up in the sidebar, so sharing one link shares the whole web of documents.
function discoverLinks(md) {
  // Absolute links (inline or <autolink>) to this host, and relative ](/id) links.
  const re = /https?:\/\/([^/\s)>\]]+)\/([A-Za-z0-9]{8,32})(?![\w/])|\]\(\/([A-Za-z0-9]{8,32})\)/g
  let added = false
  for (const [, host, abs, rel] of md.matchAll(re)) {
    if (host && host !== location.host) continue
    const id = abs || rel
    if (id === current || docs.some(d => d.id === id)) continue
    docs.push({ id, title: '', at: 0 })
    added = true
  }
  if (added) { store.set('docs', docs); refreshTitles() }
}

// ---------- editor ----------

const hub = new Hub(location.origin + '/hub')
const sync = new DocSync(hub, randomId(10))
let titleTimer

function openLink(href) {
  let u
  try { u = new URL(href, location.href) } catch { return }
  const m = u.origin === location.origin && u.pathname.match(ID)
  if (m) go(m[1])
  else if (/^(https?|mailto):$/.test(u.protocol)) window.open(u.href, '_blank', 'noopener')
}

/** Wraps the selection in a markdown marker (bold/italic), or removes it if already wrapped. */
const wrap = marker => view => {
  view.dispatch(view.state.changeByRange(r => {
    const doc = view.state.doc, n = marker.length
    if (doc.sliceString(r.from - n, r.from) === marker && doc.sliceString(r.to, r.to + n) === marker)
      return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) }
    return { changes: [{ from: r.from, insert: marker }, { from: r.to, insert: marker }], range: EditorSelection.range(r.from + n, r.to + n) }
  }))
  return true
}

/**
 * Enter like Obsidian: on an empty list item / task / quote line, remove the marker
 * (or un-indent a nested item) instead of continuing; otherwise continue the markup.
 */
function enter(view) {
  const { state } = view
  const sel = state.selection.main
  if (sel.empty) {
    const line = state.doc.lineAt(sel.head)
    const m = /^(\s*)(?:[-*+]|\d+[.)])(?: \[[ xX]\])?\s*$|^(\s*)>\s*$/.exec(line.text)
    if (m && sel.head === line.to) {
      const indent = m[1] || ''
      if (indent) {
        // Un-indent to the parent item's indentation.
        let target = ''
        for (let n = line.number - 1; n >= 1; n--) {
          const ind = /^(\s*)(?:[-*+]|\d+[.)])\s/.exec(state.doc.line(n).text)?.[1]
          if (ind != null && ind.length < indent.length) { target = ind; break }
        }
        view.dispatch({ changes: { from: line.from, to: line.from + indent.length, insert: target } })
      } else view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from } })
      return true
    }
  }
  return insertNewlineContinueMarkup(view)
}

async function uploadImage(file) {
  const r = await fetch('/api/blobs', { method: 'POST', headers: { 'content-type': file.type }, body: file })
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).url
}

function insertImages(view, files) {
  const images = Array.from(files).filter(f => f.type.startsWith('image/'))
  if (!images.length) return false
  for (const f of images)
    uploadImage(f).then(url => {
      const alt = (f.name || 'image').replace(/[\[\]]/g, '')
      view.dispatch(view.state.replaceSelection(`![${alt}](${url})`))
    }, e => alert('Upload failed: ' + e.message))
  return true
}

function pasteLink(view, text) {
  const sel = view.state.selection.main
  if (!sel.empty) {
    view.dispatch(view.state.replaceSelection(`[${view.state.sliceDoc(sel.from, sel.to)}](${text})`))
    return
  }
  const insert = title => view.dispatch(view.state.replaceSelection(title ? `[${title.replace(/[\[\]]/g, '')}](${text})` : text))
  let m
  try { const u = new URL(text); m = u.host === location.host && u.pathname.match(ID) } catch {}
  if (!m) return insert(null)
  const known = docs.find(d => d.id === m[1])?.title
  if (known) return insert(known)
  fetch('/api/titles?ids=' + m[1]).then(r => r.json()).then(t => insert(t[m[1]]), () => insert(null))
}

const extensions = [
  sync.extension(),
  new LanguageSupport(markdownLanguage),
  livePreview(openLink),
  undoHistory(),
  keymap.of([
    { key: 'Enter', run: enter },
    { key: 'Backspace', run: deleteMarkupBackward },
    { key: 'Mod-b', run: wrap('**') },
    { key: 'Mod-i', run: wrap('*') },
    ...defaultKeymap, ...historyKeymap, indentWithTab,
  ]),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
  placeholder('Start writing…'),
  EditorView.domEventHandlers({
    paste(e, view) {
      const data = e.clipboardData
      if (!data) return false
      if (data.files.length && insertImages(view, data.files)) return true
      const text = data.getData('text/plain').trim()
      if (/^https?:\/\/\S+$/.test(text)) { pasteLink(view, text); return true }
      return false
    },
    drop(e, view) {
      if (!e.dataTransfer?.files.length) return false
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos != null) view.dispatch({ selection: { anchor: pos } })
      return insertImages(view, e.dataTransfer.files)
    },
  }),
  EditorView.updateListener.of(u => {
    if (!u.docChanged) return
    clearTimeout(titleTimer)
    titleTimer = setTimeout(onTextChanged, 300)
  }),
]

const view = new EditorView({ parent: $('#editor'), state: EditorState.create({ extensions }) })

function onTextChanged() {
  const md = view.state.doc.toString()
  const title = titleOf(md)
  document.title = (title || 'Untitled') + ' · SharedMarkdown'
  if (md.trim() || docs.some(d => d.id === current)) remember(current, title, false)
  discoverLinks(md)
}

// ---------- navigation & sync ----------

hub.onopen = () => sync.join()
hub.onstatus = online => document.body.classList.toggle('offline', !online)
hub.on('presence', n => { $('#people').textContent = n > 1 ? n + ' here' : '' })
sync.onload = () => { if (view.state.doc.length) remember(current, null, true); onTextChanged() }

async function open(id) {
  clearTimeout(titleTimer)
  if (current) onTextChanged() // record the outgoing document before the editor is cleared
  await sync.open(id, () => {
    current = id
    // Fresh editor state per document, so undo history doesn't leak between documents.
    view.setState(EditorState.create({ extensions }))
    document.title = 'SharedMarkdown'
    $('#people').textContent = ''
    document.body.classList.remove('nav')
    renderList()
  })
}

function go(id) {
  if (id === current) return
  history.pushState(null, '', '/' + id)
  open(id)
  view.focus()
}

window.addEventListener('popstate', () => {
  const m = location.pathname.match(ID)
  open(m ? m[1] : randomId(12))
})

$('#list').addEventListener('click', e => {
  const a = e.target.closest('a')
  if (!a || e.ctrlKey || e.metaKey) return
  e.preventDefault()
  go(a.getAttribute('href').slice(1))
})
$('#new').onclick = () => go(randomId(12))
$('#menu').onclick = () => document.body.classList.toggle('nav')
$('#scrim').onclick = () => document.body.classList.remove('nav')
$('#copy').onclick = async e => {
  await navigator.clipboard.writeText(location.href)
  e.target.textContent = 'Copied'
  setTimeout(() => e.target.textContent = 'Copy link', 1200)
}
$('#theme').onclick = () => {
  const root = document.documentElement
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  root.dataset.theme = dark ? 'light' : 'dark'
  store.set('theme', root.dataset.theme)
}
window.addEventListener('beforeunload', e => { if (sync.dirty) e.preventDefault() })

const m = location.pathname.match(ID)
const first = m ? m[1] : randomId(12)
if (!m) history.replaceState(null, '', '/' + first)
open(first)
refreshTitles()
view.focus()
