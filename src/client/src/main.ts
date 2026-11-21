import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView, keymap, placeholder, type Command } from '@codemirror/view'
import { history as undoHistory, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Language, LanguageSupport } from '@codemirror/language'
import { markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import type { MarkdownParser } from '@lezer/markdown'
import { livePreview, Highlight, localImages } from './livepreview'
import { tableEnter, tableArrow, insertTable } from './table'
import { slashMenu } from './slash'
import { Hub } from './hub'
import { DocSync } from './sync'

/** An element from index.html, which always has it. */
function $<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error('missing element ' + sel)
  return el
}
const ID = /^\/([A-Za-z0-9]{8,32})$/

function randomId(n: number) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  while (s.length < n) for (const b of crypto.getRandomValues(new Uint8Array(n))) if (b < 248 && s.length < n) s += abc[b % 62]
  return s
}

const store = {
  get<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

// ---------- recent documents (this browser only) ----------

/**
 * A document in this browser's list. `at` is when it was added: the list is ordered by it, newest
 * first, and never reshuffles when you click an entry (like tabs or a file list, unlike a recents list).
 */
interface DocEntry { id: string, title: string, at: number }
let docs = store.get<DocEntry[]>('docs', [])
/** Documents removed from the list; link discovery doesn't add them back until they are opened again. */
let dismissed = new Set(store.get<string[]>('dismissed', []))
let current = '' // id of the open document ('' until the first one opens)

/** First line with text, without markdown syntax: images dropped, links reduced to their text. Mirrors DocStore.TitleOf. */
function titleOf(md: string) {
  for (const raw of md.split('\n')) {
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|==|`/g, '')
      .replace(/\\(.)/g, '$1')
      .trim().replace(/^([#>\-*+]+|\d+[.)])(\s+|$)/, '').replace(/^\[[ xX]\]\s+/, '').trim()
    if (line) return line.slice(0, 80)
  }
  return ''
}

function remember(id: string, title: string | null, opened: boolean) {
  if (opened && dismissed.delete(id)) store.set('dismissed', [...dismissed])
  let d = docs.find(d => d.id === id)
  if (!d) docs.push(d = { id, title: '', at: Date.now() })
  if (title != null) d.title = title
  store.set('docs', docs)
  renderList()
}

function renderList() {
  const list = $('#list')
  list.textContent = ''
  const shown = docs.some(d => d.id === current) ? docs : [...docs, { id: current, title: '', at: Infinity }]
  for (const d of [...shown].sort((a, b) => b.at - a.at)) {
    // A row is the link plus a separate remove button (a button inside a link would also open it).
    const row = document.createElement('div')
    row.className = d.id === current ? 'item on' : 'item'
    const a = document.createElement('a')
    a.href = '/' + d.id
    a.textContent = d.title || 'Untitled'
    const x = document.createElement('button')
    x.className = 'x'
    x.title = 'Remove from list'
    x.setAttribute('aria-label', `Remove ${a.textContent} from list`)
    x.textContent = '×'
    x.onclick = () => removeFromList(d.id)
    row.append(a, x)
    list.append(row)
  }
}

/** Forgets a document in this browser (it isn't deleted; the link still works). */
function removeFromList(id: string) {
  docs = docs.filter(d => d.id !== id)
  dismissed.add(id)
  store.set('docs', docs)
  store.set('dismissed', [...dismissed])
  if (id === current) go(randomId(12))
  else renderList()
}

async function refreshTitles() {
  const ids = docs.filter(d => d.id !== current).map(d => d.id)
  if (!ids.length) return
  try {
    const titles: Record<string, string> = await (await fetch('/api/titles?ids=' + ids.join(','))).json()
    for (const d of docs) if (titles[d.id]) d.title = titles[d.id]
    store.set('docs', docs)
    renderList()
  } catch {}
}

// Linked documents show up in the sidebar, so sharing one link shares the whole web of documents.
function discoverLinks(md: string) {
  // Absolute links (inline or <autolink>) to this host, and relative ](/id) links.
  const re = /https?:\/\/([^/\s)>\]]+)\/([A-Za-z0-9]{8,32})(?![\w/])|\]\(\/([A-Za-z0-9]{8,32})\)/g
  let added = false
  for (const [, host, abs, rel] of md.matchAll(re)) {
    if (host && host !== location.host) continue
    const id = abs || rel
    if (id === current || dismissed.has(id) || docs.some(d => d.id === id)) continue
    // Right below the document that links to it.
    const parent = docs.find(d => d.id === current)?.at ?? Date.now()
    docs.push({ id, title: '', at: parent - 1 - docs.length / 1000 })
    added = true
  }
  if (added) { store.set('docs', docs); refreshTitles() }
}

// ---------- editor ----------

const hub = new Hub(location.origin + '/hub')
const sync = new DocSync(hub, randomId(10))
let titleTimer: ReturnType<typeof setTimeout> | undefined

function openLink(href: string) {
  let u: URL
  try { u = new URL(href, location.href) } catch { return }
  const m = u.origin === location.origin && u.pathname.match(ID)
  if (m) go(m[1])
  else if (/^(https?|mailto):$/.test(u.protocol)) window.open(u.href, '_blank', 'noopener')
}

/** Wraps the selection in a markdown marker (bold/italic), or removes it if already wrapped. */
const wrap = (marker: string): Command => view => {
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
function enter(view: EditorView) {
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

/**
 * Shrinks an image in the browser before uploading: scales it to the server's size limit and
 * re-encodes photos as JPEG. Browsers put copied images on the clipboard as PNG, which for a
 * photo is ~10x larger than the original JPEG. The server still validates and re-encodes
 * everything; this only saves the transfer.
 */
async function shrinkImage(file: File, maxDimension: number): Promise<Blob> {
  if (file.type === 'image/gif') return file // keep animations
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file) } // applies EXIF rotation
  catch { return file } // not decodable here; let the server decide
  try {
    const { width, height } = bitmap
    const scale = Math.min(1, maxDimension / Math.max(width, height))
    // Photos compress badly as PNG (> 1 byte per pixel); screenshots stay PNG for crisp text.
    const photoPng = file.type === 'image/png' && file.size / (width * height) > 1
    if (scale === 1 && !photoPng) return file
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    let type = file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png'
    if (photoPng && isOpaque(ctx, w, h)) type = 'image/jpeg'
    const out = await canvas.convertToBlob({ type, quality: 0.85 })
    return out.size < file.size ? out : file
  } finally { bitmap.close() }
}

function isOpaque(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  const data = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false
  return true
}

async function uploadImage(file: File) {
  const body = await shrinkImage(file, sync.maxImageDimension)
  const r = await fetch('/api/blobs', { method: 'POST', headers: { 'content-type': body.type || file.type }, body })
  if (!r.ok) throw new Error(await r.text())
  const { url }: { url: string } = await r.json()
  return url
}

/** Replaces the markdown src `from` with `to` wherever it currently is (the text may have moved). */
function replaceSrc(view: EditorView, from: string, to: string | null) {
  const doc = view.state.doc.toString()
  const changes = []
  const re = new RegExp(String.raw`!\[[^\]]*\]\(${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\)`, 'g')
  for (const m of doc.matchAll(re)) {
    const at = m.index
    changes.push(to === null
      ? { from: at, to: at + m[0].length }
      : { from: at + m[0].length - from.length - 1, to: at + m[0].length - 1, insert: to })
  }
  if (changes.length) view.dispatch({ changes })
}

/**
 * Pasted/dropped images appear at once: a placeholder `upload:<token>` src is inserted and shown
 * with the local file; when the upload is done the src becomes the real `/b/<id>` URL.
 * Other people see "Uploading image…" in the meantime.
 */
function insertImages(view: EditorView, files: FileList) {
  const images = Array.from(files).filter(f => f.type.startsWith('image/'))
  if (!images.length) return false
  const inserts = images.map(f => {
    const token = `upload:${Date.now()}-${randomId(6)}`
    const preview = URL.createObjectURL(f)
    localImages.set(token, preview)
    const alt = (f.name || 'image').replace(/[\[\]]/g, '').replace(/\.\w+$/, '')
    return { f, token, preview, md: `![${alt}](${token})` }
  })
  view.dispatch(view.state.replaceSelection(inserts.map(i => i.md).join('\n')))
  for (const { f, token, preview } of inserts)
    uploadImage(f).then(url => {
      localImages.set(url, preview)
      localImages.delete(token)
      replaceSrc(view, token, url)
    }, (e: Error) => {
      localImages.delete(token)
      URL.revokeObjectURL(preview)
      replaceSrc(view, token, null)
      notice('Upload failed: ' + e.message, 6000)
    })
  return true
}

function pasteLink(view: EditorView, text: string) {
  const sel = view.state.selection.main
  if (!sel.empty) {
    view.dispatch(view.state.replaceSelection(`[${view.state.sliceDoc(sel.from, sel.to)}](${text})`))
    return
  }
  const insert = (title: string | null | undefined) => view.dispatch(view.state.replaceSelection(title ? `[${title.replace(/[\[\]]/g, '')}](${text})` : text))
  let m: RegExpMatchArray | null | false = null
  try { const u = new URL(text); m = u.host === location.host && u.pathname.match(ID) } catch {}
  if (!m) return insert(null)
  const id = m[1]
  const known = docs.find(d => d.id === id)?.title
  if (known) return insert(known)
  fetch('/api/titles?ids=' + id).then(r => r.json()).then((t: Record<string, string>) => insert(t[id]), () => insert(null))
}

// GFM markdown plus ==highlight==. Same language data as markdownLanguage, so its commands
// (insertNewlineContinueMarkup checks markdownLanguage.isActiveAt) keep working.
// lang-markdown types its language's parser as a plain lezer Parser; it is a MarkdownParser.
const markdown = new Language(markdownLanguage.data, (markdownLanguage.parser as MarkdownParser).configure([Highlight]), [], 'markdown')

/** A blank line before `from` when it follows text (a table or `---` would otherwise attach to it). */
const blankBefore = (view: EditorView, from: number) => {
  const line = view.state.doc.lineAt(from)
  return line.number > 1 && from === line.from && view.state.doc.line(line.number - 1).text.trim() ? '\n' : ''
}

const slashItems = slashMenu([
  {
    label: 'Table', hint: '3 columns, a header and 2 rows', icon: '▦', keywords: 'grid columns rows',
    run: (view, from, to) => insertTable(view, from, to, [['Column 1', 'Column 2', 'Column 3'], ['', '', ''], ['', '', '']]),
  },
  {
    label: 'Code block', hint: 'Monospace, keeps spacing', icon: '{ }', keywords: 'code fence snippet',
    run: (view, from, to) => {
      const lead = blankBefore(view, from)
      view.dispatch({ changes: { from, to, insert: lead + '```\n\n```' }, selection: { anchor: from + lead.length + 4 }, userEvent: 'input' })
    },
  },
  {
    label: 'Divider', hint: 'A horizontal line', icon: '—', keywords: 'rule hr line separator',
    run: (view, from, to) => {
      const lead = blankBefore(view, from)
      view.dispatch({ changes: { from, to, insert: lead + '---\n' }, selection: { anchor: from + lead.length + 4 }, userEvent: 'input' })
    },
  },
  {
    label: 'Image', hint: 'Upload from this device', icon: '▣', keywords: 'picture photo upload',
    run: (view, from, to) => {
      view.dispatch({ changes: { from, to }, selection: { anchor: from } })
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/png,image/jpeg,image/gif,image/webp'
      input.multiple = true
      input.onchange = () => { if (input.files?.length) insertImages(view, input.files) }
      input.click()
    },
  },
])

const extensions = [
  slashItems,
  sync.extension(),
  new LanguageSupport(markdown),
  livePreview(openLink),
  undoHistory(),
  keymap.of([
    { key: 'Enter', run: v => tableEnter(v) || enter(v) },
    { key: 'ArrowDown', run: tableArrow(true) },
    { key: 'ArrowUp', run: tableArrow(false) },
    { key: 'Backspace', run: deleteMarkupBackward },
    { key: 'Mod-b', run: wrap('**') },
    { key: 'Mod-i', run: wrap('*') },
    { key: 'Mod-Shift-h', run: wrap('==') },
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
// For automated tests (?debug): lets a test drive the editor even in a background tab.
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { cmView: view })

function onTextChanged() {
  const md = view.state.doc.toString()
  const title = titleOf(md)
  document.title = (title || 'Untitled') + ' · SharedMarkdown'
  if ((md.trim() || docs.some(d => d.id === current)) && !dismissed.has(current)) remember(current, title, false)
  discoverLinks(md)
}

// ---------- navigation & sync ----------

let noticeTimer: ReturnType<typeof setTimeout> | undefined
function notice(message: string, ms?: number) {
  const n = $('#notice')
  n.textContent = message
  n.hidden = false
  clearTimeout(noticeTimer)
  if (ms) noticeTimer = setTimeout(() => { n.hidden = true }, ms)
}
sync.notice = notice
sync.clearNotice = () => { $('#notice').hidden = true }

// After a deploy, open tabs reconnect to a server that may speak a newer protocol: reload first.
const build = new URL($<HTMLScriptElement>('script[type=module]').src).pathname
hub.onopen = async () => {
  let version: string
  try { version = await hub.invoke('Version') } catch { return }
  if (version && version !== build && sessionStorage.getItem('reloadedFor') !== version) {
    notice('Updating to the new version…')
    try {
      sessionStorage.setItem('reloadedFor', version)
      // Unsent edits can't be trusted to the old protocol: keep the text and merge it after reloading.
      if (sync.dirty) sessionStorage.setItem('unsaved', JSON.stringify({ id: current, text: view.state.doc.toString() }))
    } catch {}
    location.reload()
    return
  }
  sync.join()
}
hub.onstatus = online => document.body.classList.toggle('offline', !online)
hub.on('presence', n => { $('#people').textContent = n > 1 ? n + ' here' : '' })
sync.onload = () => {
  try {
    const saved: { id: string, text: string } | null = JSON.parse(sessionStorage.getItem('unsaved') ?? 'null')
    sessionStorage.removeItem('unsaved')
    if (saved?.id === current) sync.mergeText(saved.text)
  } catch {}
  if (view.state.doc.length) remember(current, null, true)
  onTextChanged()
}

async function open(id: string) {
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

function go(id: string) {
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
  const a = e.target instanceof Element ? e.target.closest('a') : null
  if (!a || e.ctrlKey || e.metaKey) return
  e.preventDefault()
  go(a.getAttribute('href')!.slice(1)) // renderList gives every entry an href
})
$('#new').onclick = () => go(randomId(12))
$('#menu').onclick = () => document.body.classList.toggle('nav')
$('#scrim').onclick = () => document.body.classList.remove('nav')
const copy = $('#copy')
copy.onclick = async () => {
  await navigator.clipboard.writeText(location.href)
  copy.textContent = 'Copied'
  setTimeout(() => copy.textContent = 'Copy link', 1200)
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
