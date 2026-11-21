import { Hub, hubError } from './hub'
import { DocSync } from './sync'
import { setupOffline } from './offline'
import { createEditor } from './editor'
import { Sidebar, prefs, titleOf } from './sidebar'
import { docKey, isReadKey, newDocId, randomId } from './ids'

function $<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error('missing element ' + sel)
  return el
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined
function notice(message: string, ms?: number) {
  const n = $('#notice')
  n.textContent = message
  n.hidden = false
  clearTimeout(noticeTimer)
  if (ms) noticeTimer = setTimeout(() => { n.hidden = true }, ms)
}
const clearNotice = () => { $('#notice').hidden = true }

const hub = new Hub(location.origin + '/hub')
const sync = new DocSync({ hub, client: randomId(10), notice, clearNotice })
const offline = setupOffline(hub, sync)

const sidebar = new Sidebar({
  el: $('#list'),
  current: () => sync.key,
  leave: () => go(newDocId()),
  forget: key => { sync.store.forget(key).catch(e => console.warn('Forgetting the copy on this device failed', e)) },
})

let titleTimer: ReturnType<typeof setTimeout> | undefined
const editor = createEditor({
  parent: $('#editor'),
  area: $('main'),
  sync,
  images: { online: () => hub.connected, maxDimension: () => sync.maxImageDimension, notice },
  openLink,
  linkTitle: async key => sidebar.title(key) ?? (await sidebar.fetchTitles([key]))[key] ?? null,
  onDocChanged: () => {
    clearTimeout(titleTimer)
    titleTimer = setTimeout(textChanged, 300)
  },
})
const view = editor.view
// Automated tests (?debug) drive the editor through this, even in a background tab.
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { cmView: view, smHub: hub, smSync: sync })

// The page's own title (index.html) stays while a document is empty: it is what search engines see for "/".
// A document's page comes with its title for link previews, and the site's in data-site.
const siteTitle = document.querySelector('title')?.dataset.site ?? document.title

function textChanged() {
  const md = view.state.doc.toString()
  const title = titleOf(md)
  document.title = title ? title + ' · SharedMarkdown' : siteTitle
  sidebar.textChanged(sync.key, md)
}

function openLink(href: string) {
  let u: URL
  try { u = new URL(href, location.href) } catch { return }
  const key = u.origin === location.origin && docKey(u.pathname)
  if (key) go(key)
  else if (/^(https?|mailto):$/.test(u.protocol)) window.open(u.href, '_blank', 'noopener')
}

// ---------- navigation ----------

async function open(key: string) {
  clearTimeout(titleTimer)
  if (sync.loaded) textChanged() // the outgoing document, before the editor is cleared
  await sync.open(key, () => {
    editor.reset(key)
    document.body.classList.toggle('readonly', isReadKey(key))
    setShareMenu(false, false)
    document.title = siteTitle
    $('#people').textContent = ''
    document.body.classList.remove('nav')
    sidebar.render()
  })
}

function go(key: string) {
  if (key === sync.key) return
  history.pushState(null, '', '/' + key)
  open(key)
  view.focus()
}

window.addEventListener('popstate', () => open(docKey(location.pathname) ?? newDocId()))
$('#list').addEventListener('click', e => {
  const a = e.target instanceof Element ? e.target.closest('a') : null
  if (!a || e.ctrlKey || e.metaKey) return
  e.preventDefault()
  go(a.getAttribute('href')!.slice(1))
})
$('#new').onclick = () => go(newDocId())
$('#menu').onclick = () => document.body.classList.toggle('nav')
$('#scrim').onclick = () => document.body.classList.remove('nav')

// ---------- sync events ----------

sync.on('load', () => {
  restoreAfterReload()
  if (view.state.doc.length) sidebar.remember(sync.key, null, true)
  else if (!hub.connected && !sync.cached && sidebar.has(sync.key))
    notice("This document isn't stored on this device yet; it loads when you're back online.", 6000)
  textChanged()
})
sync.on('deleted', key => sidebar.drop(key))
hub.on('presence', n => { $('#people').textContent = n > 1 ? n + ' here' : '' })

// After a deploy, open tabs reconnect to a server that may speak a newer protocol: reload first.
const build = new URL($<HTMLScriptElement>('script[type=module]').src).pathname
hub.on('open', async () => {
  let version: string
  try { version = await hub.invoke('Version') } catch { return }
  if (version && version !== build && sessionStorage.getItem('reloadedFor') !== version) {
    notice('Updating to the new version…')
    try { sessionStorage.setItem('reloadedFor', version) } catch {}
    await keepUnsentForReload()
    location.reload()
    return
  }
  await sync.join()
  offline.syncOthers()
})

/** Unsent edits survive the reload in IndexedDB; without it they go through sessionStorage, as text. */
async function keepUnsentForReload() {
  await sync.copy.persist()
  if (await sync.store.db) return
  const unsent = sync.unsentEdits()
  try { if (unsent) sessionStorage.setItem('unsaved', JSON.stringify(unsent)) } catch {}
}

function restoreAfterReload() {
  let saved: ReturnType<DocSync['unsentEdits']> = null
  try {
    saved = JSON.parse(sessionStorage.getItem('unsaved') ?? 'null')
    sessionStorage.removeItem('unsaved')
  } catch {}
  if (saved?.key === sync.key) sync.restore(saved.text, saved.base)
}

// ---------- share ----------
// "Copy link" copies the link this page was opened with (on a read-only page that's the read-only
// link: the edit link is never known there); the arrow opens a menu with "Copy read-only link".

const copy = $('#copy'), more = $('#copy-more'), shareMenu = $('#copy-menu')
copy.onclick = async () => {
  await navigator.clipboard.writeText(location.origin + '/' + sync.key)
  copy.textContent = 'Copied'
  setTimeout(() => copy.textContent = 'Copy link', 1200)
}

const readIds = new Map<string, string>()
async function readLink() {
  const key = sync.key
  let r = readIds.get(key)
  if (!r) readIds.set(key, r = await hub.invoke('ReadLink', key))
  return location.origin + '/r/' + r
}

function setShareMenu(open: boolean, focusButton = true) {
  if (shareMenu.hidden === !open) return
  shareMenu.hidden = !open
  more.setAttribute('aria-expanded', String(open))
  if (open) shareMenu.querySelector<HTMLElement>('[role=menuitem]')?.focus()
  else if (focusButton) more.focus()
}
more.onclick = () => setShareMenu(!!shareMenu.hidden)
more.onkeydown = e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setShareMenu(true) }
}
shareMenu.onkeydown = e => {
  const items = [...shareMenu.querySelectorAll<HTMLElement>('[role=menuitem]')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? -1 : null
  if (to !== null) { e.preventDefault(); items.at(to % items.length)?.focus() }
  else if (e.key === 'Escape') { e.preventDefault(); setShareMenu(false) }
  else if (e.key === 'Tab') setShareMenu(false, false)
}
document.addEventListener('pointerdown', e => {
  if (!shareMenu.hidden && !(e.target instanceof Node && $('#share').contains(e.target))) setShareMenu(false, false)
})
$('#copy-ro').onclick = async () => {
  setShareMenu(false)
  const link = readLink()
  try {
    // A ClipboardItem with a promise keeps the click's permission (Safari) while the server answers.
    if (typeof ClipboardItem !== 'undefined') await navigator.clipboard.write([new ClipboardItem({ 'text/plain': link.then(l => new Blob([l], { type: 'text/plain' })) })])
    else await navigator.clipboard.writeText(await link)
    notice('Read-only link copied. People with it can view, not edit.', 3000)
  } catch {
    let l: string
    try { l = await link } catch (e) {
      notice(hubError(e) === 'create' ? "You've created many documents in the last hour; try again later."
        : "Couldn't get a read-only link. Are you offline?", 5000)
      return
    }
    notice('Read-only link: ' + l, 15000) // no clipboard access: show it for copying by hand
  }
}

$('#theme').onclick = () => {
  const root = document.documentElement
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  root.dataset.theme = dark ? 'light' : 'dark'
  prefs.set('theme', root.dataset.theme)
}

// ---------- boot ----------

const first = docKey(location.pathname) ?? newDocId()
if (first !== location.pathname.slice(1)) history.replaceState(null, '', '/' + first)
open(first)
sidebar.refreshTitles()
view.focus()
