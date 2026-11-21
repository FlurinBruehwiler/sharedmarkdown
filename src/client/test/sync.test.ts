// DocSync against a fake hub and a fake editor view (no DOM): document switches while a join is in
// flight, offline edits that no longer apply as ops, and documents deleted by an administrator.
import { test } from 'node:test'
import assert from 'node:assert'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { Emitter, type HubEvents, type JoinResult, type ServerMethods } from '../src/hub'
import { DocSync, remote, rebase } from '../src/sync'
import { Rga, applyAll, type Op } from '../src/rga'

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

class FakeHub extends Emitter<HubEvents> {
  connected = true
  docs = new Map<string, Rga>()
  deleted = new Set<string>()
  /** Join answers wait for release(key) when the key is held. */
  held = new Map<string, (() => void)[]>()
  holding = new Set<string>()

  doc(key: string) {
    let d = this.docs.get(key)
    if (!d) this.docs.set(key, d = new Rga('server'))
    return d
  }
  release(key: string) {
    this.holding.delete(key)
    for (const go of this.held.get(key) ?? []) go()
    this.held.delete(key)
  }
  send() {}
  async invoke<K extends keyof ServerMethods>(target: K, ...args: ServerMethods[K]['args']): Promise<ServerMethods[K]['result']> {
    if (!this.connected) throw new Error('offline')
    const key = args[0] as string
    if (target === 'Join') {
      if (this.holding.has(key)) await new Promise<void>(r => this.held.set(key, [...this.held.get(key) ?? [], r]))
      if (this.deleted.has(key)) throw new Error("An unexpected error occurred invoking 'Join' on the server. HubException: deleted")
      return { state: this.doc(key).encode(), maxChars: 50000, maxImageDimension: 2000 } satisfies JoinResult as ServerMethods[K]['result']
    }
    if (target === 'Submit') {
      if (this.deleted.has(key)) return 'deleted' as ServerMethods[K]['result']
      const { ok } = applyAll(this.doc(key), args[1] as Op[])
      return (ok ? 'ok' : 'invalid') as ServerMethods[K]['result']
    }
    throw new Error('unexpected ' + target)
  }
}

function setup() {
  const hub = new FakeHub()
  const notices: string[] = []
  const sync = new DocSync({ hub, client: 'me', notice: m => notices.push(m), clearNotice: () => {} })
  const view = {
    state: EditorState.create(),
    dispatch(spec: TransactionSpec) {
      const tr = this.state.update(spec)
      this.state = tr.state
      if (tr.docChanged && !tr.annotation(remote)) sync.local(tr.changes)
    },
  }
  sync.view = view as never
  const reset = () => { view.state = EditorState.create() }
  const type = (at: number, text: string) => view.dispatch({ changes: { from: at, insert: text } })
  return { hub, sync, view, reset, type, notices, text: () => view.state.doc.toString() }
}

test('switching documents while a join is in flight shows the new document only', async () => {
  const { hub, sync, reset, text } = setup()
  hub.doc('docA').apply(new Rga('x').splice(0, 0, 'text of A'))
  hub.doc('docB').apply(new Rga('y').splice(0, 0, 'text of B'))
  hub.holding.add('docA')
  const a = sync.open('docA', reset)
  await tick()
  const b = sync.open('docB', reset)
  await b
  assert.strictEqual(text(), 'text of B')
  hub.release('docA') // A's answer arrives late
  await a
  await tick()
  assert.strictEqual(text(), 'text of B')
  assert.strictEqual(sync.rga.text(), 'text of B')
  assert.strictEqual(sync.key, 'docB')
})

test('offline edits whose origin is gone are merged as text, keeping what others wrote', async () => {
  const { hub, sync, reset, type, text } = setup()
  await sync.open('docC', reset)
  type(0, 'abc def')
  await tick(50)
  assert.strictEqual(hub.doc('docC').text(), 'abc def')
  hub.connected = false
  hub.emit('status', false)
  type(2, 'X') // after "b", offline
  type(text().length, ' mine')
  // Meanwhile someone deletes "b" and adds "!", and the server drops the tombstone (compaction keeps visible ids).
  const other = new Rga('other')
  other.load(hub.doc('docC').encode())
  hub.doc('docC').apply([...other.splice(1, 1, ''), ...other.splice(6, 0, '!')])
  const compacted = new Rga('server')
  compacted.load(hub.doc('docC').encode().filter(run => !run[3]))
  hub.docs.set('docC', compacted)
  assert.strictEqual(compacted.text(), 'ac def!')
  hub.connected = true
  await sync.join()
  await tick(50)
  assert.strictEqual(text(), 'aXc def mine!') // " mine" still applies as an op; it and "!" follow "f" in RGA order
  assert.strictEqual(hub.doc('docC').text(), 'aXc def mine!')
})

test('rebase applies what still applies and merges the rest', () => {
  const server = new Rga('s'), local = new Rga('me')
  const base = new Rga('b').splice(0, 0, 'one two three')
  server.apply(base)
  local.apply(base)
  local.splice(4, 0, 'big ') // an op that never reached the server
  const pending = [...local.splice(8, 0, 'X'), ...local.splice(0, 0, '> ')] // after the lost text (fails), at the start (applies)
  assert.strictEqual(local.text(), '> one big Xtwo three')
  const ops = rebase(server, pending, local)
  assert.strictEqual(server.text(), '> one Xtwo three')
  const check = new Rga('c')
  check.apply(base)
  check.apply(ops)
  assert.strictEqual(check.text(), server.text())
})

test('a document deleted by an administrator stops syncing and is never resubmitted', async () => {
  const { hub, sync, reset, type, notices } = setup()
  const deleted: string[] = []
  sync.on('deleted', key => deleted.push(key))
  await sync.open('docD', reset)
  type(0, 'hello')
  await tick(50)
  hub.deleted.add('docD')
  type(5, ' again')
  await tick(50)
  assert.deepStrictEqual(deleted, ['docD'])
  assert.ok(sync.deleted && !sync.dirty)
  assert.ok(notices.some(n => /removed by an administrator/.test(n)))
  type(0, 'x')
  await tick(50)
  assert.strictEqual(hub.doc('docD').text(), 'hello')
  // Opening it again: Join says "deleted".
  await sync.open('docE', reset)
  await sync.open('docD', reset)
  assert.ok(sync.deleted)
})
