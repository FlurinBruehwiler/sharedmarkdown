import { Annotation, ChangeSet, EditorState, StateEffect, Transaction, type Extension, type Range } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { Rga, applyAll, compactOps, firstBatch, type Id, type Op, type TextChange } from './rga'
import { diff } from './text'
import { FORMAT, LocalDocs, type DocRecord } from './local'
import type { Hub, JoinResult, SubmitStatus } from './hub'

/** Marks transactions that apply other people's changes (or the server's copy) rather than local edits. */
export const remote = Annotation.define<boolean>()
const cursorsChanged = StateEffect.define<null>()

type Timer = ReturnType<typeof setTimeout>
interface Snapshot { doc: DocRecord, ops: Op[], adopted: string[], version: number }

/**
 * Keeps one document in sync. The editor text is exactly the RGA text: local editor changes
 * become RGA ops sent to the server, remote ops are integrated and applied to the editor as changes.
 *
 * Offline: the state and the unsent ops are also kept on this device (local.ts), written shortly
 * after every change. A document opened without a connection shows that copy and can be edited;
 * the ops pile up in the outbox and join() merges them when the connection is back.
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
  /** This device's copy of documents (IndexedDB). */
  readonly store: LocalDocs
  /** Stored copy of the open document, shown if it opens without a connection. */
  cached: DocRecord | null = null
  /** Pending records of closed tabs whose ops are in our outbox; removed when we next save ours. */
  adopted: string[] = []
  /** Text from a stored copy in an older format, merged as text once joined. */
  recoverText: string | null = null
  /** Whether the latest state and unsent ops are on disk (so closing the tab loses nothing). */
  saved = true
  /** True while open() switches documents; join() waits for it. */
  switching = false
  /** Called when the sync state changes (unsent edits, saved, loaded), for the status line. */
  onchange: (() => void) | null = null
  version = 0
  seq = 0
  lastAt = 0
  pt?: Timer
  lt?: Timer

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
    this.store = new LocalDocs(client)
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
      if (this.id) this.store.drop(this.id).catch(() => {})
      this.onchange?.()
      this.notice?.('This document was removed by an administrator.' + (this.readOnly ? '' : ' Changes here are no longer saved.'))
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

  /** Opened through a read-only link: `id` is then "r/{readId}"; nothing is ever submitted. */
  get readOnly() { return !!this.id?.startsWith('r/') }

  /** Switches to document `id`. `reset` gives the editor a fresh state once the old document is detached. */
  async open(id: string, reset: () => void) {
    const seq = ++this.seq
    this.switching = true
    const prev = this.snapshot()
    this.loaded = false
    this.deleted = false
    this.limited = false
    clearTimeout(this.rt)
    clearTimeout(this.lt)
    clearTimeout(this.pt)
    this.clearNotice?.()
    this.cursors.clear()
    reset()
    // The server only accepts ops for the joined document, so send what's left before switching.
    await this.drain()
    // Whatever is still unsent stays on this device: it's sent when that document is opened again,
    // or by syncOthers (offline.ts) once the connection is back.
    if (prev) { prev.ops = [...(this.inflight || []), ...this.outbox]; await this.write(prev) }
    if (seq !== this.seq) return // another open() took over
    this.id = id
    this.rga = new Rga(this.client)
    this.outbox = []
    this.inflight = null
    this.cached = null
    this.adopted = []
    this.recoverText = null
    this.saved = true
    // Unsent ops kept on this device (ours, or of tabs that were closed) are merged like any unsent edit.
    const { doc, pending } = await this.store.load(id)
    if (seq !== this.seq) return
    const current = pending.every(p => p.v === FORMAT)
    if (doc && doc.v === FORMAT && current) this.cached = doc
    else if (doc) this.recoverText = doc.text
    for (const p of pending) {
      if (current) this.outbox.push(...p.ops)
      this.adopted.push(p.key)
    }
    this.switching = false
    this.onchange?.()
    if (this.hub.connected) await this.join()
    // Not connected: show the stored copy at once if the browser knows it's offline, else give the connection a moment.
    else this.lt = setTimeout(() => this.loadLocal(), navigator.onLine === false ? 0 : 1500)
  }

  /** Shows the stored copy (or an empty new document) while there is no connection; edits go to the outbox. */
  loadLocal() {
    if (this.loaded || this.joining || this.switching || this.deleted || !this.id || this.hub.connected) return
    const typed = this.editor.state.doc.toString() // typed before this
    this.rga.load(this.cached?.state ?? [])
    applyAll(this.rga, this.outbox) // normally already in the stored state, unless another tab wrote it last
    this.loaded = true
    const text = this.rga.text()
    if (typed && !text) this.outbox.push(...this.rga.splice(0, 0, typed))
    else this.replaceAll(text)
    this.schedulePersist()
    this.onload?.()
  }

  // ---------- this device's copy ----------

  /** Current state and unsent ops of the open document, for saving. */
  snapshot(): Snapshot | null {
    if (!this.id || !this.loaded || this.deleted) return null
    const at = this.lastAt = Math.max(Date.now(), this.lastAt + 1)
    return {
      doc: { id: this.id, v: FORMAT, state: this.rga.encode(), text: this.rga.text(), at },
      ops: compactOps([...(this.inflight || []), ...this.outbox]),
      adopted: [...this.adopted],
      version: this.version,
    }
  }

  async write(snap: Snapshot) {
    let ok = false
    try { ok = await this.store.save(snap.doc, snap.ops, snap.adopted) } catch {}
    if (ok && snap.doc.id === this.id) {
      this.adopted = this.adopted.filter(k => !snap.adopted.includes(k))
      if (snap.version === this.version) this.saved = true
    }
    this.onchange?.()
  }

  /** Saves the open document shortly (changes come in bursts). */
  schedulePersist() {
    if (!this.id || !this.loaded || this.deleted) return
    this.version++
    this.saved = false
    clearTimeout(this.pt)
    this.pt = setTimeout(() => this.persist(), 300)
    this.onchange?.()
  }

  /** Saves the open document now (e.g. the tab is being hidden or closed). */
  persist() {
    clearTimeout(this.pt)
    const snap = this.snapshot()
    return snap ? this.write(snap) : Promise.resolve()
  }

  /** Edits that would be lost if the tab closed now: unsent and not (yet) on disk. */
  get unsaved() { return this.dirty && !this.saved }

  /** (Re)joins the current document; local edits (unsent, or made while joining) survive. */
  async join() {
    const id = this.id
    if (!id || this.deleted || this.switching) return
    const wasLoaded = this.loaded
    this.joining = true
    this.buffer = []
    let res: JoinResult
    try { res = this.readOnly ? await this.hub.invoke('JoinRead', id.slice(2)) : await this.hub.invoke('Join', id) }
    catch (e) {
      if (e instanceof Error && /rate/.test(e.message)) { // invoke only rejects with Errors
        this.notice?.('Opening documents too quickly, retrying in a moment…')
        this.retry(() => this.join(), 15000)
      } else if (e instanceof Error && /not found/.test(e.message) && id === this.id) {
        // The server answered: this view-only link is gone, so a stored copy would be misleading.
        this.notice?.("This view-only link doesn't work: the document doesn't exist or was removed.")
        return
      }
      this.joining = false
      if (id === this.id) this.loadLocal() // meanwhile show this device's copy, if not connected
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
    // meantime (it does when nobody has it open), some ids are gone: keep the ops that still apply
    // and merge the rest by text. (Ops kept offline may come from several tabs; applyAll orders them.)
    const { ok: merged, applied } = applyAll(this.rga, pending)
    this.rga.apply(this.buffer)
    this.buffer = []
    this.outbox = applied
    this.loaded = true
    const text = this.rga.text()
    if (typed && !text) this.outbox.push(...this.rga.splice(0, 0, typed))
    else if (!merged) {
      const d = diff(text, local)
      this.outbox.push(...this.rga.splice(d.p, d.d, d.i))
    } else this.replaceAll(text)
    if (this.recoverText !== null) {
      const t = this.recoverText
      this.recoverText = null
      this.mergeText(t)
    }
    this.schedulePersist()
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
    this.schedulePersist()
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
    if (!this.loaded || this.readOnly) return
    const list: [from: number, to: number, text: string][] = []
    changes.iterChanges((fromA, toA, _fromB, _toB, text) => list.push([fromA, toA, text.toString()]))
    // Apply back to front so earlier positions stay valid.
    for (let i = list.length - 1; i >= 0; i--) {
      const [from, to, text] = list[i]
      this.outbox.push(...this.rga.splice(from, to - from, text))
    }
    this.schedulePersist()
    clearTimeout(this.t)
    this.t = setTimeout(() => this.flush(), 20)
  }

  remote(ops: Op[]) {
    if (this.joining) return void this.buffer.push(...ops)
    if (!this.loaded) return
    let changes: TextChange[]
    try { changes = this.rga.apply(ops) } catch { return void this.join() }
    this.dispatchRemote(changes)
    this.schedulePersist()
  }

  async flush() {
    if (this.inflight || this.joining || this.deleted || this.readOnly || !this.outbox.length || !this.hub.connected || !this.id) return
    // After a long time offline the outbox can be large: send it in batches the hub accepts.
    const [batch, rest] = firstBatch(compactOps(this.outbox))
    this.inflight = batch
    this.outbox = rest
    let status: SubmitStatus
    try { status = await this.hub.invoke('Submit', this.id, batch) } catch { return } // reconnect resends
    if (this.inflight !== batch) return
    this.inflight = null
    if (status === 'ok') {
      if (this.limited) { this.limited = false; this.clearNotice?.() }
      this.schedulePersist()
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
    if (!this.loaded || !this.hub.connected || !this.view || this.readOnly) return
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
