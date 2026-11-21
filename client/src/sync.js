import { Annotation, ChangeSet, StateEffect, Transaction } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import { Rga } from './rga.js'

const remote = Annotation.define()
const cursorsChanged = StateEffect.define()

/**
 * Keeps one document in sync. The editor text is exactly the RGA text: local editor changes
 * become RGA ops sent to the server, remote ops are integrated and applied to the editor as changes.
 */
export class DocSync {
  constructor(hub, client) {
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
  }

  /** CodeMirror extensions: change capture and remote cursors. Must come before other plugins. */
  extension() {
    const sync = this
    return [
      ViewPlugin.define(view => {
        sync.view = view
        return {
          update(u) {
            for (const tr of u.transactions) if (tr.docChanged && !tr.annotation(remote)) sync.local(tr.changes)
            if (u.selectionSet || u.docChanged) sync.cursorMoved()
          },
        }
      }),
      ViewPlugin.fromClass(class {
        constructor(view) { this.decorations = sync.cursorDecorations(view) }
        update(u) {
          if (u.docChanged || u.transactions.some(t => t.effects.some(e => e.is(cursorsChanged)))) this.decorations = sync.cursorDecorations(u.view)
        }
      }, { decorations: v => v.decorations }),
    ]
  }

  /** Switches to document `id`. `reset` gives the editor a fresh state once the old document is detached. */
  async open(id, reset) {
    this.loaded = false
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
    if (!id) return
    const wasLoaded = this.loaded
    this.joining = true
    this.buffer = []
    let state
    try { state = await this.hub.invoke('Join', id) } catch { return } finally { this.joining = false }
    if (id !== this.id) return
    const typed = wasLoaded ? null : this.view.state.doc.toString() // typed before the document finished loading
    const pending = [...(this.inflight || []), ...this.outbox]
    this.inflight = null
    this.rga.load(state)
    this.rga.apply(pending)
    this.rga.apply(this.buffer)
    this.buffer = []
    this.outbox = pending
    this.loaded = true
    const text = this.rga.text()
    if (typed && !text) this.outbox.push(...this.rga.splice(0, 0, typed))
    else this.replaceAll(text)
    this.onload?.()
    this.lastCursor = null
    this.sendCursor()
    this.flush()
  }

  replaceAll(text) {
    const cur = this.view.state.doc.toString()
    if (cur === text) return
    let s = 0, e = 0
    const n = Math.min(cur.length, text.length)
    while (s < n && cur.charCodeAt(s) === text.charCodeAt(s)) s++
    while (e < n - s && cur.charCodeAt(cur.length - 1 - e) === text.charCodeAt(text.length - 1 - e)) e++
    this.dispatchRemote([{ from: s, to: cur.length - e, insert: text.slice(s, text.length - e) }])
  }

  dispatchRemote(changes) {
    if (!changes.length) return
    let len = this.view.state.doc.length
    let set = ChangeSet.empty(len)
    for (const c of changes) {
      const step = ChangeSet.of(c, len)
      set = set.compose(step)
      len = step.newLength
    }
    this.view.dispatch({ changes: set, annotations: [remote.of(true), Transaction.addToHistory.of(false)] })
  }

  local(changes) {
    if (!this.loaded) return
    const list = []
    changes.iterChanges((fromA, toA, _fromB, _toB, text) => list.push([fromA, toA, text.toString()]))
    // Apply back to front so earlier positions stay valid.
    for (let i = list.length - 1; i >= 0; i--) {
      const [from, to, text] = list[i]
      this.outbox.push(...this.rga.splice(from, to - from, text))
    }
    clearTimeout(this.t)
    this.t = setTimeout(() => this.flush(), 20)
  }

  remote(ops) {
    if (this.joining) return void this.buffer.push(...ops)
    if (!this.loaded) return
    let changes
    try { changes = this.rga.apply(ops) } catch { return void this.join() }
    this.dispatchRemote(changes)
  }

  async flush() {
    if (this.inflight || this.joining || !this.outbox.length || !this.hub.connected) return
    const batch = this.inflight = this.outbox
    this.outbox = []
    let ok
    try { ok = await this.hub.invoke('Submit', this.id, batch) } catch { return } // reconnect resends
    if (this.inflight !== batch) return
    this.inflight = null
    if (!ok) return void this.join()
    this.flush()
  }

  async drain() {
    clearTimeout(this.t)
    for (let i = 0; i < 40 && (this.outbox.length || this.inflight) && this.hub.connected; i++) {
      await this.flush()
      if (this.inflight) await new Promise(r => setTimeout(r, 50))
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
    const id = this.rga.idAt(this.view.state.selection.main.head) || ['', 0]
    const key = id.join(':')
    if (key === this.lastCursor) return
    this.lastCursor = key
    this.hub.send('Cursor', id[0], id[1])
  }

  cursorDecorations(view) {
    if (!this.loaded) return Decoration.none
    const decos = []
    for (const [peer, [c, k]] of this.cursors) {
      const pos = this.rga.posOf(c, k)
      if (pos < 0 || pos > view.state.doc.length) continue
      decos.push(Decoration.widget({ widget: new Caret(peer), side: 1 }).range(pos))
    }
    return Decoration.set(decos, true)
  }
}

class Caret extends WidgetType {
  constructor(peer) { super(); this.peer = peer }
  eq(o) { return o.peer === this.peer }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-ghost'
    let h = 0
    for (const ch of this.peer) h = (h * 31 + ch.charCodeAt(0)) % 360
    el.style.setProperty('--ghost', `hsl(${h} 75% 55%)`)
    return el
  }
}
