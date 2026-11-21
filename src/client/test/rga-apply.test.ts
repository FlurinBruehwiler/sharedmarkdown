// Rga.apply: same result as the straightforward per-character integration it replaced, unknown
// deletes are no-ops, and large remote edits are fast.
import { test } from 'node:test'
import assert from 'node:assert'
import { Rga, applyAll, compactOps, type Op, type TextChange } from '../src/rga'

let seed = 3
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
const word = () => 'abcdefgh'.slice(0, 1 + rnd(5))

/** The previous apply(): one character at a time, indexOf + visibleBefore per character. */
class RefRga extends Rga {
  override apply(ops: Op[]): TextChange[] {
    const changes: TextChange[] = []
    let last: TextChange | null = null
    const push = (from: number, to: number, insert: string) => {
      if (last && !last.insert && to === from + 1 && !insert && last.from === from) last.to++
      else if (last && last.to === last.from && insert && from === last.from + last.insert.length) last.insert += insert
      else changes.push(last = { from, to, insert })
    }
    const k2 = (c: string, k: number) => c + ':' + k
    for (const op of ops) {
      if (op[0] === 'i') {
        const [, c, k, oc, ok, text] = op
        let origin: string | null = oc ? k2(oc, ok) : null
        for (let j = 0; j < text.length; j++) {
          if (this.byId.has(k2(c, k + j))) { origin = k2(c, k + j); continue }
          let idx = 0
          if (origin) {
            const o = this.byId.get(origin)
            if (!o) throw new Error('missing origin')
            idx = this.items.indexOf(o) + 1
          }
          while (idx < this.items.length && (this.items[idx].k !== k + j ? this.items[idx].k > k + j : this.items[idx].c > c)) idx++
          const it = { c, k: k + j, ch: text[j], del: false }
          this.items.splice(idx, 0, it)
          this.byId.set(k2(c, k + j), it)
          if (k + j > this.clock) this.clock = k + j
          origin = k2(c, k + j)
          push(this.visibleBefore(idx), this.visibleBefore(idx), text[j])
        }
      } else {
        const [, c, k, n] = op
        for (let j = 0; j < n; j++) {
          const it = this.byId.get(k2(c, k + j))
          if (!it || it.del) continue
          const vis = this.visibleBefore(this.items.indexOf(it))
          it.del = true
          push(vis, vis + 1, '')
        }
      }
    }
    this.cache = null
    return changes
  }
}

const replay = (text: string, changes: TextChange[]) => {
  for (const ch of changes) text = text.slice(0, ch.from) + ch.insert + text.slice(ch.to)
  return text
}

test('apply integrates exactly like the per-character reference', () => {
  for (let round = 0; round < 300; round++) {
    const peers = [new Rga('a'), new Rga('b'), new Rga('c')].map(rga => ({ rga, inbox: [] as Op[][] }))
    const ops: Op[][] = []
    for (let step = 0; step < 25; step++) {
      const r = peers[rnd(3)]
      for (let n = rnd(3); n > 0 && r.inbox.length; n--) r.rga.apply(r.inbox.shift()!) // others' edits arrive late
      const t = r.rga.text()
      const p = rnd(t.length + 1), d = rnd(Math.min(6, t.length - p) + 1)
      const o = r.rga.splice(p, d, rnd(3) ? word() : '')
      ops.push(o)
      for (const other of peers) if (other !== r) other.inbox.push(o)
    }
    // A prefix, then everything compacted (so partly a repeat), then a repeated suffix.
    const all = ops.flat()
    const batches = [all.slice(0, rnd(all.length + 1)), compactOps(all), all.slice(rnd(all.length + 1))]
    const fast = new Rga('x'), ref = new RefRga('x')
    for (const b of batches) {
      const before = fast.text()
      const ch = fast.apply(b)
      ref.apply(b)
      // Runs of deletes report their changes in document order rather than op order: same result.
      assert.strictEqual(replay(before, ch), fast.text(), 'change list wrong in round ' + round)
    }
    assert.deepStrictEqual(fast.encode(), ref.encode(), 'state differs in round ' + round)
  }
})

test('deleting an unknown id is a no-op', () => {
  const a = new Rga('a')
  a.apply([['i', 'b', 1, '', 0, 'hello']])
  assert.deepStrictEqual(a.apply([['d', 'zz', 4, 3]]), [])
  assert.deepStrictEqual(a.apply([['d', 'b', 4, 5]]), [{ from: 3, to: 5, insert: '' }]) // b:6..8 don't exist
  assert.strictEqual(a.text(), 'hel')
})

test('applyAll: deletes of characters that are gone count as applied', () => {
  const server = new Rga('s')
  server.apply([['i', 'b', 1, '', 0, 'abc']])
  const res = applyAll(server, [['d', 'gone', 1, 2], ['d', 'b', 2, 1], ['i', 'me', 1, 'b', 3, '!']])
  assert.ok(res.ok)
  assert.strictEqual(server.text(), 'ac!')
  const bad = applyAll(server, [['i', 'me', 5, 'gone', 1, 'x'], ['d', 'b', 1, 1]])
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(server.text(), 'c!')
})

test('textWithout undoes this replica\'s own ops', () => {
  const a = new Rga('a'), b = new Rga('b')
  a.apply(b.splice(0, 0, 'shared text'))
  const mine = [...a.splice(0, 6, ''), ...a.splice(a.text().length, 0, ' + mine')]
  a.apply(b.splice(b.text().length, 0, '!'))
  assert.strictEqual(a.text(), ' text! + mine')
  assert.strictEqual(a.textWithout(mine), 'shared text!')
})

test('large remote edits are fast (select all + delete, paste)', () => {
  const a = new Rga('a'), b = new Rga('b')
  // A 50k document typed by two people in alternating short runs, so the delete has many runs.
  for (let i = 0; i < 2500; i++) {
    const r = i % 2 ? a : b, o = i % 2 ? b : a
    o.apply(r.splice(r.text().length, 0, 'abcdefghi' + (i % 10) + 'abcdefghi' + (i % 10)))
  }
  assert.strictEqual(a.text().length, 50000)
  let t = performance.now()
  const del = a.splice(0, a.text().length, '')
  assert.ok(del.length > 1000)
  const changes = b.apply(del)
  assert.deepStrictEqual(changes, [{ from: 0, to: 50000, insert: '' }])
  assert.ok(performance.now() - t < 500, 'delete took ' + (performance.now() - t) + ' ms')
  t = performance.now()
  b.apply(a.splice(0, 0, 'x'.repeat(50000)))
  assert.strictEqual(b.text().length, 50000)
  assert.ok(performance.now() - t < 500, 'insert took ' + (performance.now() - t) + ' ms')
})
