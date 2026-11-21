import { Annotation, ChangeSet, EditorState, StateEffect, Transaction, type Extension, type Range } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { Rga, diff, type Id, type Op, type TextChange } from './rga'
import type { Hub, JoinResult, SubmitStatus } from './hub'

const remote = Annotation.define<boolean>()
const cursorsChanged = StateEffect.define<null>()

type Timer = ReturnType<typeof setTimeout>

/**
 * Keeps one document in sync. The editor text is exactly the RGA text: local editor changes
 * become RGA ops sent to the server, remote ops are integrated and applied to the editor as changes.
 */
export class DocSync {
  readonly hub: Hub
  readonly client: string
  view: EditorView | null
  id: string | null
  rga: Rga
  loaded: boolean
  outbox: Op[]
  inflight: Op[] | null
  buffer: Op[]
  cursors: Map<string, Id>
  onload: (() => void) | null
  notice: ((message: string, ms?: number) => void) | null
  clearNotice: (() => void) | null
  maxChars: number
  maxImageDimension = 2000
  lastCursor?: string | null
  deleted?: boolean
  joining?: boolean
  limited?: boolean
  rt?: Timer
  t?: Timer
  ct?: Timer

  constructor(hub: Hub, client: string) {
    this.hub = hub
    this.client = client
    this.view = null
    this.id = null
    this.rga = new Rga(client)
    this.loaded = false
    this.outbox = []      // ops not yet sent
    this.inflight = null  // ops sent, waiting for ack
    this.buffer = []      // remote ops received while joining
    this.cursors = new Map() // peer -> [client, clock] anchor
    this.onload = null
    hub.on('ops', ops => this.remote(ops))
    hub.on('cursor', (peer, c, k) => {
      if (c === null) this.cursors.delete(peer)
      else this.cursors.set(peer, [c, k])
      this.view?.dispatch({ effects: cursorsChanged.of(null) })
    })
    hub.on('peer', () => { this.lastCursor = null; this.sendCursor() })
    hub.on('deleted', () => {
      this.deleted = true
      this.loaded = false
      this.outbox = []
      this.inflight = null
      this.notice?.('This document was removed by an administrator. Changes here are no longer saved.')
    })
    this.notice = null      // (message, ms?) => void, set by the app
    this.clearNotice = null
    this.maxChars = 0
  }

  retry(fn: () => void, ms: number) {
    clearTimeout(this.rt)
    this.rt = setTimeout(fn, ms)
  }

  /** CodeMirror extensions: change capture and remote cursors. Must come before other plugins. */
  extension(): Extension {
    const sync = this
    return [
      // Refuse local edits that would grow the document past the server's size limit.
      EditorState.transactionFilter.of(tr => {
        if (!tr.docChanged || tr.annotation(remote) || !sync.maxChars) return tr
        if (tr.newDoc.length > sync.maxChars && tr.newDoc.length > tr.startState.doc.length) {
          sync.notice?.(`Documents can be at most ${sync.maxChars.toLocaleString()} characters.`, 4000)
          return []
        }
        return tr
      }),
      ViewPlugin.define(view => {
        sync.view = view
        return {
          update(u: ViewUpdate) {
            for (const tr of u.transactions) if (tr.docChanged && !tr.annotation(remote)) sync.local(tr.changes)
            if (u.selectionSet || u.docChanged) sync.cursorMoved()
          },
        }
      }),
      ViewPlugin.fromClass(class {
        decorations: DecorationSet
        constructor(view: EditorView) { this.decorations = sync.cursorDecorations(view) }
        update(u: ViewUpdate) {
          if (u.docChanged || u.transactions.some(t => t.effects.some(e => e.is(cursorsChanged)))) this.decorations = sync.cursorDecorations(u.view)
        }
      }, { decorations: v => v.decorations }),
    ]
  }

  /** Switches to document `id`. `reset` gives the editor a fresh state once the old document is detached. */
  async open(id: string, reset: () => void) {
    this.loaded = false
    this.deleted = false
    this.limited = false
    clearTimeout(this.rt)
    this.clearNotice?.()
    this.cursors.clear()
    reset()
    // The server only accepts ops for the joined document, so send what's left before switching.
    await this.drain()
    this.id = id
    this.rga = new Rga(this.client)
    this.outbox = []
    this.inflight = null
    if (this.hub.connected) await this.join()
  }

  /** (Re)joins the current document; local edits (unsent, or made while joining) survive. */
  async join() {
    const id = this.id
    if (!id || this.deleted) return
    const wasLoaded = this.loaded
    this.joining = true
    this.buffer = []
    let res: JoinResult
    try { res = await this.hub.invoke('Join', id) }
    catch (e) {
      if (e instanceof Error && /rate/.test(e.message)) { // invoke only rejects with Errors
        this.notice?.('Opening documents too quickly, retrying in a moment…')
        this.retry(() => this.join(), 15000)
      }
      return
    } finally { this.joining = false }
    if (id !== this.id) return
    this.maxChars = res.maxChars
    this.maxImageDimension = res.maxImageDimension
    const local = this.editor.state.doc.toString()
    const typed = wasLoaded ? null : local // typed before the document finished loading
    const pending = [...(this.inflight || []), ...this.outbox]
    this.inflight = null
    this.rga.load(res.state)
    // Our unsent edits reference characters by id. If the server compacted the document in the
    // meantime (it does when nobody has it open), those ids are gone: merge by text instead.
    let merged = true
    try { this.rga.apply(pending) } catch { merged = false; this.rga.load(res.state) }
    this.rga.apply(this.buffer)
    this.buffer = []
    this.outbox = merged ? pending : []
    this.loaded = true
    const text = this.rga.text()
    if (typed && !text) this.outbox.push(...this.rga.splice(0, 0, typed))
    else if (!merged) {
      const d = diff(text, local)
      this.outbox.push(...this.rga.splice(d.p, d.d, d.i))
    } else this.replaceAll(text)
    this.onload?.()
    this.lastCursor = null
    this.sendCursor()
    this.flush()
  }

  /** Brings the document to `text` as a local edit (used to restore edits kept across a reload). */
  mergeText(text: string) {
    const d = diff(this.rga.text(), text)
    if (!d.d && !d.i) return
    this.outbox.push(...this.rga.splice(d.p, d.d, d.i))
    this.replaceAll(this.rga.text())
    this.flush()
  }

  /** The editor; extension()'s plugin sets it when the view is created, before any document opens. */
  get editor(): EditorView {
    if (!this.view) throw new Error('DocSync: editor view not created yet')
    return this.view
  }

  replaceAll(text: string) {
    const cur = this.editor.state.doc.toString()
    if (cur === text) return
    let s = 0, e = 0
    const n = Math.min(cur.length, text.length)
    while (s < n && cur.charCodeAt(s) === text.charCodeAt(s)) s++
    while (e < n - s && cur.charCodeAt(cur.length - 1 - e) === text.charCodeAt(text.length - 1 - e)) e++
    this.dispatchRemote([{ from: s, to: cur.length - e, insert: text.slice(s, text.length - e) }])
  }

  dispatchRemote(changes: TextChange[]) {
    if (!changes.length) return
    let len = this.editor.state.doc.length
    let set = ChangeSet.empty(len)
    for (const c of changes) {
      const step = ChangeSet.of(c, len)
      set = set.compose(step)
      len = step.newLength
    }
    this.editor.dispatch({ changes: set, annotations: [remote.of(true), Transaction.addToHistory.of(false)] })
  }

  local(changes: ChangeSet) {
    if (!this.loaded) return
    const list: [from: number, to: number, text: string][] = []
    changes.iterChanges((fromA, toA, _fromB, _toB, text) => list.push([fromA, toA, text.toString()]))
    // Apply back to front so earlier positions stay valid.
    for (let i = list.length - 1; i >= 0; i--) {
      const [from, to, text] = list[i]
      this.outbox.push(...this.rga.splice(from, to - from, text))
    }
    clearTimeout(this.t)
    this.t = setTimeout(() => this.flush(), 20)
  }

  remote(ops: Op[]) {
    if (this.joining) return void this.buffer.push(...ops)
    if (!this.loaded) return
    let changes: TextChange[]
    try { changes = this.rga.apply(ops) } catch { return void this.join() }
    this.dispatchRemote(changes)
  }

  async flush() {
    if (this.inflight || this.joining || this.deleted || !this.outbox.length || !this.hub.connected || !this.id) return
    const batch = this.inflight = this.outbox
    this.outbox = []
    let status: SubmitStatus
    try { status = await this.hub.invoke('Submit', this.id, batch) } catch { return } // reconnect resends
    if (this.inflight !== batch) return
    this.inflight = null
    if (status === 'ok') {
      if (this.limited) { this.limited = false; this.clearNotice?.() }
      return void this.flush()
    }
    if (status === 'create' || status === 'rate') {
      // Keep the edits and try again later; nothing is lost while this tab stays open.
      this.outbox = [...batch, ...this.outbox]
      this.limited = true
      this.notice?.(status === 'create'
        ? "You've created many documents in the last hour, so this one can't be saved yet. Keep this tab open; it saves automatically once the limit allows."
        : 'Too many edits at once, retrying…')
      return this.retry(() => this.flush(), status === 'create' ? 60000 : 5000)
    }
    if (status === 'size') this.notice?.(`This document is at its size limit (${this.maxChars.toLocaleString()} characters); the last change wasn't saved.`, 6000)
    this.join() // refused edit: reload the server's version
  }

  async drain() {
    clearTimeout(this.t)
    for (let i = 0; i < 40 && (this.outbox.length || this.inflight) && this.hub.connected; i++) {
      await this.flush()
      if (this.inflight) await new Promise<void>(r => setTimeout(r, 50))
    }
  }

  get dirty() { return !!(this.outbox.length || this.inflight) }

  // ---------- ghost cursors ----------

  cursorMoved() {
    clearTimeout(this.ct)
    this.ct = setTimeout(() => this.sendCursor(), 40)
  }

  sendCursor() {
    if (!this.loaded || !this.hub.connected || !this.view) return
    const id: Id = this.rga.idAt(this.view.state.selection.main.head) || ['', 0]
    const key = id.join(':')
    if (key === this.lastCursor) return
    this.lastCursor = key
    this.hub.send('Cursor', id[0], id[1])
  }

  cursorDecorations(view: EditorView): DecorationSet {
    if (!this.loaded) return Decoration.none
    const decos: Range<Decoration>[] = []
    for (const [peer, [c, k]] of this.cursors) {
      const pos = this.rga.posOf(c, k)
      if (pos < 0 || pos > view.state.doc.length) continue
      decos.push(Decoration.widget({ widget: new Caret(peer), side: 1 }).range(pos))
    }
    return Decoration.set(decos, true)
  }
}

class Caret extends WidgetType {
  peer: string
  constructor(peer: string) { super(); this.peer = peer }
  override eq(o: Caret) { return o.peer === this.peer }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-ghost'
    let h = 0
    for (const ch of this.peer) h = (h * 31 + ch.charCodeAt(0)) % 360
    el.style.setProperty('--ghost', `hsl(${h} 75% 55%)`)
    return el
  }
}
