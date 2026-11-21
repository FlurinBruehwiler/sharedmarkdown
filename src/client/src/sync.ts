import { Annotation, ChangeSet, EditorState, StateEffect, Transaction, type Extension, type Range } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { Rga, applyAll, compactOps, firstBatch, type Id, type Op, type StateRun, type TextChange } from './rga'
import { FORMAT, LocalCopy, LocalDocs, type DocRecord } from './local'
import { diff, merge3 } from './text'
import { isReadKey, readIdOf } from './ids'
import { Emitter, hubError, type Hub, type JoinResult, type SubmitStatus } from './hub'

/** Marks transactions that apply other people's changes (or the server's copy) rather than local edits. */
export const remote = Annotation.define<boolean>()
const cursorsChanged = StateEffect.define<null>()

type Timer = ReturnType<typeof setTimeout>

export type SyncHub = Pick<Hub, 'invoke' | 'send' | 'on' | 'connected'>

export interface SyncEvents {
  change: []
  load: []
  deleted: [key: string]
}

export interface DocSyncOptions {
  hub: SyncHub
  client: string
  store?: LocalDocs
  notice: (message: string, ms?: number) => void
  clearNotice: () => void
}

/**
 * Keeps one document in sync. The editor text is exactly the RGA text: local editor changes
 * become RGA ops sent to the server, remote ops are integrated and applied to the editor as changes.
 */
export class DocSync extends Emitter<SyncEvents> {
  readonly hub: SyncHub
  readonly client: string
  readonly store: LocalDocs
  readonly copy: LocalCopy
  readonly notice: (message: string, ms?: number) => void
  readonly clearNotice: () => void
  view: EditorView | null = null
  /** The open document's key (ids.ts); '' until the first open(). Set as soon as open() starts. */
  key = ''
  /** While open() switches away from a document: that document's key (its unsent ops are being sent). */
  draining: string | null = null
  /** Bumped by every open(); async work checks it after each await and gives up if it changed. */
  seq = 0
  rga: Rga
  loaded = false
  /** The connection is joined to the document (Submit goes to it). Cleared on disconnect. */
  joined = false
  /** `seq` of the join() in flight, or 0. Remote ops are buffered meanwhile. */
  joining = 0
  deleted = false
  readonly gone = new Set<string>()
  limited = false
  outbox: Op[] = []
  inflight: Op[] | null = null
  /** Remote ops received while joining. */
  buffer: Op[] = []
  readonly cursors = new Map<string, Id>()
  lastCursor: string | null = null
  maxChars = 0
  maxImageDimension = 2000
  cached: DocRecord | null = null
  /** A stored copy in an older format (ops unusable): merged as text once joined. */
  recover: { text: string, base?: string } | null = null
  joinRetryTimer: Timer | undefined
  flushRetryTimer: Timer | undefined
  flushTimer: Timer | undefined
  cursorTimer: Timer | undefined
  offlineTimer: Timer | undefined

  constructor({ hub, client, store, notice, clearNotice }: DocSyncOptions) {
    super()
    this.hub = hub
    this.client = client
    this.rga = new Rga(client)
    this.store = store ?? new LocalDocs(client)
    this.notice = notice
    this.clearNotice = clearNotice
    this.copy = new LocalCopy(this.store, () => this.loaded && !this.deleted && !this.switching ? { rga: this.rga, pending: this.pending } : null, () => this.emit('change'))
    hub.on('ops', ops => this.remote(ops))
    hub.on('cursor', (peer, c, k) => {
      if (c === null) this.cursors.delete(peer)
      else this.cursors.set(peer, [c, k])
      this.view?.dispatch({ effects: cursorsChanged.of(null) })
    })
    hub.on('peer', () => { this.lastCursor = null; this.sendCursor() })
    // During a switch the connection is still in the previous document's group.
    hub.on('deleted', () => this.documentDeleted(this.draining ?? this.key))
    hub.on('status', online => {
      if (online) return
      this.joined = false
      this.copy.persist()
    })
  }

  /** CodeMirror extensions: change capture and remote cursors. Must come before other plugins. */
  extension(): Extension {
    const sync = this
    return [
      EditorState.transactionFilter.of(tr => {
        if (!tr.docChanged || tr.annotation(remote) || !sync.maxChars) return tr
        if (tr.newDoc.length > sync.maxChars && tr.newDoc.length > tr.startState.doc.length) {
          sync.notice(`Documents can be at most ${sync.maxChars.toLocaleString()} characters.`, 4000)
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

  get readOnly() { return isReadKey(this.key) }
  get switching() { return this.draining !== null }
  get pending() { return [...this.inflight || [], ...this.outbox] }
  get dirty() { return !!(this.outbox.length || this.inflight) }
  get unsaved() { return this.dirty && !this.copy.saved }

  get editor(): EditorView {
    if (!this.view) throw new Error('DocSync: editor view not created yet')
    return this.view
  }

  async open(key: string, reset: () => void) {
    const seq = ++this.seq
    // Unsent ops in the outbox belong to the document being left (or still being left, if a switch is under way).
    const from = this.draining ?? this.key
    const prev = this.copy.snapshot()
    this.draining = from
    this.key = key
    this.loaded = false
    this.deleted = false
    this.limited = false
    for (const t of [this.joinRetryTimer, this.flushRetryTimer, this.flushTimer, this.offlineTimer]) clearTimeout(t)
    this.joinRetryTimer = this.flushRetryTimer = undefined
    this.copy.reset(key, [])
    this.clearNotice()
    this.cursors.clear()
    reset()
    // The server only accepts ops for the joined document, so send what's left before switching.
    await this.drain(from)
    // Whatever is still unsent stays on this device: it's sent when that document is opened again,
    // or by syncOthers (offline.ts) once the connection is back.
    if (prev && !this.gone.has(prev.doc.key)) {
      prev.ops = compactOps(this.pending)
      await this.copy.write(prev)
    }
    if (seq !== this.seq) return
    this.rga = new Rga(this.client)
    this.outbox = []
    this.inflight = null
    this.cached = null
    this.recover = null
    const { doc, pending } = await this.store.load(key)
    if (seq !== this.seq) return
    this.draining = null
    this.joined = false
    const current = pending.every(p => p.v === FORMAT)
    if (doc && doc.v === FORMAT && current) this.cached = doc
    else if (doc) this.recover = { text: doc.text, base: doc.base }
    if (current) for (const p of pending) this.outbox.push(...p.ops)
    this.copy.reset(key, pending.map(p => p.name))
    this.emit('change')
    if (this.hub.connected) await this.join()
    // Not connected: show the stored copy at once if the browser knows it's offline, else give the connection a moment.
    else this.offlineTimer = setTimeout(() => this.loadLocal(), typeof navigator !== 'undefined' && navigator.onLine === false ? 0 : 1500)
  }

  loadLocal() {
    if (this.loaded || this.joining || this.switching || this.deleted || !this.key || this.hub.connected) return
    const typed = this.editor.state.doc.toString()
    this.rga.load(this.cached?.state ?? [])
    applyAll(this.rga, this.outbox) // normally already in the stored state, unless another tab wrote it last
    this.loaded = true
    this.show(typed)
    this.copy.changed()
    this.emit('load')
  }

  show(typed: string) {
    if (typed && !this.rga.text()) this.outbox.push(...this.rga.splice(0, 0, typed))
    else this.replaceAll(this.rga.text())
  }

  async join() {
    const key = this.key, seq = this.seq
    if (!key || this.deleted || this.switching || this.joining === seq) return
    clearTimeout(this.joinRetryTimer)
    this.joinRetryTimer = undefined
    const wasLoaded = this.loaded
    this.joining = seq
    this.buffer = []
    let res: JoinResult
    try { res = this.readOnly ? await this.hub.invoke('JoinRead', readIdOf(key)) : await this.hub.invoke('Join', key) }
    catch (e) {
      if (seq !== this.seq) return
      this.joining = 0
      const code = hubError(e)
      if (code === 'deleted') return this.documentDeleted(key)
      if (code === 'not found' && this.readOnly) {
        // The server answered: this view-only link is gone, so a stored copy would be misleading.
        this.notice("This view-only link doesn't work: the document doesn't exist or was removed.")
        return
      }
      if (code === 'rate') {
        this.notice('Opening documents too quickly, retrying in a moment…')
        this.joinRetryTimer = setTimeout(() => { this.joinRetryTimer = undefined; this.join() }, 15000)
      } else if (code !== 'offline' && code !== 'closed') console.warn('Joining the document failed', e)
      this.loadLocal()
      return
    } finally { if (this.joining === seq) this.joining = 0 }
    if (seq !== this.seq) return
    this.joined = true
    this.maxChars = res.maxChars
    this.maxImageDimension = res.maxImageDimension
    const typed = wasLoaded ? '' : this.editor.state.doc.toString()
    const pending = this.pending
    const local = wasLoaded ? this.rga : this.cached && pending.length ? replicaOf(this.client, this.cached.state, pending) : null
    const server = new Rga(this.client)
    server.load(res.state)
    server.clock = Math.max(server.clock, this.rga.clock) // never reuse a clock this tab already used
    // Ops kept offline may come from several tabs; applyAll orders them.
    this.outbox = rebase(server, pending, local)
    if (this.recover) this.outbox.push(...mergeText(server, this.recover.base ?? server.text(), this.recover.text))
    this.recover = null
    applyAll(server, this.buffer) // ops that may be from the previous document fail harmlessly
    this.buffer = []
    this.inflight = null
    this.rga = server
    this.loaded = true
    this.show(typed)
    this.copy.changed()
    this.emit('load')
    this.lastCursor = null
    this.sendCursor()
    this.flush()
  }

  rejoin() {
    if (this.joinRetryTimer === undefined) this.join()
  }

  documentDeleted(key: string) {
    if (!key) return
    if (!this.gone.has(key)) this.store.drop(key).catch(e => console.warn('Dropping the deleted document failed', e))
    this.gone.add(key)
    if (key === this.draining || key === this.key) {
      this.outbox = []
      this.inflight = null
    }
    if (key === this.key) {
      this.deleted = true
      this.loaded = false
      this.joined = false
      this.notice('This document was removed by an administrator.' + (this.readOnly ? '' : ' Changes here are no longer saved.'))
    }
    this.emit('change')
    this.emit('deleted', key)
  }

  restore(text: string, base: string) {
    if (!this.loaded || this.readOnly) return
    const ops = mergeText(this.rga, base, text)
    if (!ops.length) return
    this.outbox.push(...ops)
    this.replaceAll(this.rga.text())
    this.copy.changed()
    this.flush()
  }

  unsentEdits(): { key: string, text: string, base: string } | null {
    if (!this.loaded || !this.dirty) return null
    return { key: this.key, text: this.rga.text(), base: this.rga.textWithout(this.pending) }
  }

  replaceAll(text: string) {
    const d = diff(this.editor.state.doc.toString(), text)
    if (d.d || d.i) this.dispatchRemote([{ from: d.p, to: d.p + d.d, insert: d.i }])
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
    for (let i = list.length - 1; i >= 0; i--) {
      const [from, to, text] = list[i]
      this.outbox.push(...this.rga.splice(from, to - from, text))
    }
    this.copy.changed()
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.flush(), 20)
  }

  remote(ops: Op[]) {
    if (this.joining) return void this.buffer.push(...ops)
    if (!this.loaded) return
    let changes: TextChange[]
    try { changes = this.rga.apply(ops) } catch { return void this.rejoin() }
    this.dispatchRemote(changes)
    this.copy.changed()
  }

  async flush(key = this.key) {
    const leaving = key === this.draining
    if (!leaving && (key !== this.key || !this.loaded || this.switching)) return
    if (!this.joined || this.inflight || this.joining || this.deleted || isReadKey(key) || !this.outbox.length || !this.hub.connected) return
    // After a long time offline the outbox can be large: send it in batches the hub accepts.
    const [batch, rest] = firstBatch(compactOps(this.outbox))
    this.inflight = batch
    this.outbox = rest
    let status: SubmitStatus
    try { status = await this.hub.invoke('Submit', key, batch) } catch { return } // reconnect resends
    if (this.inflight !== batch) return
    this.inflight = null
    const open = key === this.key
    if (status === 'ok') {
      if (this.limited) { this.limited = false; this.clearNotice() }
      if (open) this.copy.changed()
      return void this.flush(key)
    }
    if (status === 'deleted') return this.documentDeleted(key)
    if (status === 'create' || status === 'rate') {
      // Keep the edits and try again later; nothing is lost while this tab stays open.
      this.outbox = [...batch, ...this.outbox]
      if (!open) return // being left: they're saved on this device with the rest
      this.limited = true
      this.notice(status === 'create'
        ? "You've created many documents in the last hour, so this one can't be saved yet. Keep this tab open; it saves automatically once the limit allows."
        : 'Too many edits at once, retrying…')
      clearTimeout(this.flushRetryTimer)
      this.flushRetryTimer = setTimeout(() => this.flush(), status === 'create' ? 60000 : 5000)
      return
    }
    if (status === 'size') this.notice(`This document is at its size limit (${this.maxChars.toLocaleString()} characters); the last change wasn't saved.`, 6000)
    if (open) this.rejoin() // refused edit: reload the server's version
  }

  async drain(key: string) {
    clearTimeout(this.flushTimer)
    for (let i = 0; i < 40 && (this.outbox.length || this.inflight) && this.hub.connected; i++) {
      await this.flush(key)
      if (this.inflight) await new Promise<void>(r => setTimeout(r, 50))
    }
  }


  cursorMoved() {
    clearTimeout(this.cursorTimer)
    this.cursorTimer = setTimeout(() => this.sendCursor(), 40)
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

export function mergeText(rga: Rga, base: string, ours: string): Op[] {
  const edits = merge3(base, ours, rga.text())
  const ops: Op[] = []
  // Back to front: positions before an edit stay valid, and inserts at the same point keep their order.
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]
    ops.push(...rga.splice(e.from, e.to - e.from, e.insert))
  }
  return ops
}

/** Integrates this device's unsent ops into `server`; the ones that no longer apply are merged as text from `local`. */
export function rebase(server: Rga, pending: Op[], local: Rga | null): Op[] {
  const { ok, applied } = applyAll(server, pending)
  if (ok) return applied
  const done = new Set(applied)
  const failed = pending.filter(op => !done.has(op))
  if (!local) {
    console.warn(`${failed.length} unsent edits don't apply and there is no copy to merge them from`)
    return applied
  }
  // The text this device saw, without the failed ops: what they changed, as opposed to what others changed.
  return [...applied, ...mergeText(server, local.textWithout(failed), local.text())]
}

export function replicaOf(client: string, state: StateRun[], ops: Op[]) {
  const rga = new Rga(client)
  rga.load(state)
  applyAll(rga, ops)
  return rga
}
