import { isReadKey, readIdOf } from './ids'

export const prefs = {
  get<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback } catch { return fallback }
  },
  set(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
  },
}

export function titleOf(md: string) {
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

/**
 * A document in this browser's list. `at` is when it was added: the list is ordered by it, newest
 * first, and never reshuffles when you click an entry (like tabs or a file list, unlike a recents list).
 */
interface DocEntry { key: string, title: string, at: number }
/** As stored in localStorage ('docs'); `id` is the key. */
interface StoredEntry { id: string, title: string, at: number }

export interface SidebarOptions {
  el: HTMLElement
  /** Key of the open document ('' before the first one opens). */
  current: () => string
  leave: () => void
  forget: (key: string) => void
}

export class Sidebar {
  readonly opts: SidebarOptions
  docs: DocEntry[]
  /** Documents removed from the list; link discovery doesn't add them back until they are opened again. */
  readonly dismissed: Set<string>

  constructor(opts: SidebarOptions) {
    this.opts = opts
    this.docs = prefs.get<StoredEntry[]>('docs', []).map(({ id, title, at }) => ({ key: id, title, at }))
    this.dismissed = new Set(prefs.get<string[]>('dismissed', []))
  }

  save() {
    prefs.set('docs', this.docs.map(({ key, title, at }): StoredEntry => ({ id: key, title, at })))
    prefs.set('dismissed', [...this.dismissed])
  }

  has(key: string) { return this.docs.some(d => d.key === key) }
  title(key: string) { return this.docs.find(d => d.key === key)?.title || null }

  remember(key: string, title: string | null, opened: boolean) {
    if (opened) this.dismissed.delete(key)
    let d = this.docs.find(d => d.key === key)
    if (!d) this.docs.push(d = { key, title: '', at: Date.now() })
    if (title != null) d.title = title
    this.save()
    this.render()
  }

  textChanged(key: string, md: string) {
    if ((md.trim() || this.docs.some(d => d.key === key)) && !this.dismissed.has(key)) this.remember(key, titleOf(md), false)
    this.discoverLinks(key, md)
  }

  render() {
    const current = this.opts.current()
    const list = this.opts.el
    list.textContent = ''
    const shown = this.docs.some(d => d.key === current) ? this.docs : [...this.docs, { key: current, title: '', at: Infinity }]
    for (const d of [...shown].sort((a, b) => b.at - a.at)) {
      // A row is the link plus a separate remove button (a button inside a link would also open it).
      const row = document.createElement('div')
      row.className = d.key === current ? 'item on' : 'item'
      const a = document.createElement('a')
      a.href = '/' + d.key
      a.textContent = d.title || 'Untitled'
      const tag = document.createElement('span')
      if (isReadKey(d.key)) { tag.className = 'tag'; tag.textContent = 'View only' }
      const x = document.createElement('button')
      x.className = 'x'
      x.title = 'Remove from list'
      x.setAttribute('aria-label', `Remove ${a.textContent} from list`)
      x.textContent = '×'
      x.onclick = () => this.remove(d.key)
      row.append(a, tag, x)
      list.append(row)
    }
  }

  /** Forgets a document in this browser (it isn't deleted; the link still works). */
  remove(key: string) {
    this.drop(key)
    this.opts.forget(key)
    if (key === this.opts.current()) this.opts.leave()
  }

  drop(key: string) {
    this.docs = this.docs.filter(d => d.key !== key)
    this.dismissed.add(key)
    this.save()
    this.render()
  }

  /** Titles by key, from the server (read-only keys are looked up by read id and come back keyed "r/{readId}"). */
  async fetchTitles(keys: string[]): Promise<Record<string, string>> {
    const ids = keys.filter(k => !isReadKey(k)), reads = keys.filter(isReadKey).map(readIdOf)
    const r = await fetch(`/api/titles?ids=${ids.join(',')}&r=${reads.join(',')}`)
    if (!r.ok) throw new Error('titles: HTTP ' + r.status)
    return await r.json()
  }

  async refreshTitles() {
    const current = this.opts.current()
    const keys = this.docs.filter(d => d.key !== current).map(d => d.key)
    if (!keys.length) return
    let titles: Record<string, string>
    try { titles = await this.fetchTitles(keys) } catch { return } // offline: keep the titles we have
    for (const d of this.docs) if (titles[d.key]) d.title = titles[d.key]
    this.save()
    this.render()
  }

  /** Linked documents show up in the sidebar, so sharing one link shares the whole web of documents. */
  discoverLinks(current: string, md: string) {
    // A view-only link shouldn't fill the viewer's list with edit links (they're still in the text, though).
    if (isReadKey(current)) return
    // Absolute links (inline or <autolink>) to this host, and relative ](/id) links.
    const re = /https?:\/\/([^/\s)>\]]+)\/([A-Za-z0-9]{8,32})(?![\w/])|\]\(\/([A-Za-z0-9]{8,32})\)/g
    let added = false
    for (const [, host, abs, rel] of md.matchAll(re)) {
      if (host && host !== location.host) continue
      const key = abs || rel
      if (key === current || this.dismissed.has(key) || this.docs.some(d => d.key === key)) continue
      // Right below the document that links to it.
      const parent = this.docs.find(d => d.key === current)?.at ?? Date.now()
      this.docs.push({ key, title: '', at: parent - 1 - this.docs.length / 1000 })
      added = true
    }
    if (added) { this.save(); this.refreshTitles() }
  }
}
