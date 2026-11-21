// Randomized convergence test: N clients edit concurrently; a simulated server applies
// submitted batches in arrival order and relays them, like DocHub does.
import { Rga, applyAll, compactOps, firstBatch, type Op } from '../src/rga'
import assert from 'node:assert'

let seed = 1
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
const word = () => 'abcdefgh'.slice(0, 1 + rnd(4))

for (let round = 0; round < 300; round++) {
  const server = new Rga('server')
  const clients = [0, 1, 2].map(i => ({ rga: new Rga('c' + i), queue: [] as Op[][], inbox: [] as Op[][] }))
  for (let step = 0; step < 60; step++) {
    const c = clients[rnd(3)]
    switch (rnd(4)) {
      case 0: case 1: { // local edit
        const t = c.rga.text()
        const p = rnd(t.length + 1), d = rnd(Math.min(3, t.length - p) + 1)
        c.queue.push(c.rga.splice(p, d, rnd(3) ? word() : ''))
        break
      }
      case 2: { // client's oldest batch reaches the server
        const batch = c.queue.shift()
        if (!batch) break
        server.apply(batch)
        for (const o of clients) if (o !== c) o.inbox.push(batch)
        break
      }
      case 3: { // client receives relayed ops
        const batch = c.inbox.shift()
        if (batch) c.rga.apply(batch)
        break
      }
    }
  }
  for (const c of clients) while (c.queue.length) { const b = c.queue.shift()!; server.apply(b); for (const o of clients) if (o !== c) o.inbox.push(b) }
  for (const c of clients) while (c.inbox.length) c.rga.apply(c.inbox.shift()!)
  for (const c of clients) assert.strictEqual(c.rga.text(), server.text(), 'diverged in round ' + round)
}

// apply() must report changes that turn the old text into the new one.
for (let round = 0; round < 200; round++) {
  const a = new Rga('a'), b = new Rga('b')
  for (let step = 0; step < 30; step++) {
    const r = rnd(2) ? a : b, other = r === a ? b : a
    const t = r.text()
    const p = rnd(t.length + 1), d = rnd(Math.min(4, t.length - p) + 1)
    const ops = r.splice(p, d, rnd(3) ? word() : '')
    let text = other.text()
    for (const ch of other.apply(ops)) text = text.slice(0, ch.from) + ch.insert + text.slice(ch.to)
    assert.strictEqual(text, other.text(), 'change list wrong in round ' + round)
    assert.strictEqual(a.text(), b.text())
    const pos = rnd(a.text().length + 1), id = a.idAt(pos)
    assert.strictEqual(id ? a.posOf(id[0], id[1]) : a.posOf('', 0), pos)
  }
}
// encode() round-trips through load(), keeping ids and tombstones (an offline copy rejoins with them).
for (let round = 0; round < 100; round++) {
  const a = new Rga('a'), b = new Rga('b')
  for (let step = 0; step < 30; step++) {
    const r = rnd(2) ? a : b, other = r === a ? b : a
    const t = r.text()
    const p = rnd(t.length + 1), d = rnd(Math.min(4, t.length - p) + 1)
    other.apply(r.splice(p, d, rnd(3) ? word() : ''))
  }
  const copy = new Rga('c')
  copy.load(a.encode())
  assert.deepStrictEqual(copy.encode(), a.encode())
  assert.strictEqual(copy.text(), a.text())
  // Edits made on the copy apply to the original.
  const ops = copy.splice(rnd(copy.text().length + 1), 0, 'xy')
  a.apply(ops)
  assert.strictEqual(a.text(), copy.text(), 'encode round trip broke in round ' + round)
}

// applyAll() integrates ops given out of causal order and returns an order that applies cleanly.
for (let round = 0; round < 100; round++) {
  const a = new Rga('a'), b = new Rga('b')
  const ops: Op[] = []
  for (let step = 0; step < 20; step++) {
    const r = rnd(2) ? a : b, other = r === a ? b : a
    const t = r.text()
    const p = rnd(t.length + 1), d = rnd(Math.min(4, t.length - p) + 1)
    const o = r.splice(p, d, rnd(3) ? word() : '')
    other.apply(o)
    ops.push(...o)
  }
  const shuffled = [...ops].sort(() => rnd(3) - 1)
  const c = new Rga('c')
  const res = applyAll(c, shuffled)
  assert.ok(res.ok)
  assert.strictEqual(c.text(), a.text(), 'applyAll diverged in round ' + round)
  const d = new Rga('d')
  for (const op of res.applied) d.apply([op]) // must not throw
  assert.strictEqual(d.text(), a.text())
}
assert.strictEqual(applyAll(new Rga('e'), [['i', 'x', 5, 'y', 3, 'q']]).ok, false)

// compactOps() keeps the meaning: the compacted ops give the same document, with the same ids.
for (let round = 0; round < 100; round++) {
  const a = new Rga('a'), b = new Rga('b')
  const ops: Op[] = []
  for (let step = 0; step < 40; step++) {
    const t = a.text()
    if (rnd(4)) { const p = rnd(t.length + 1); let i = 0; for (const ch of word()) ops.push(...a.splice(p + i++, 0, ch)) } // typing
    else { const p = rnd(t.length + 1); ops.push(...a.splice(p, rnd(Math.min(4, t.length - p) + 1), '')) }
    if (!rnd(5)) { b.apply(ops); const o = b.splice(rnd(b.text().length + 1), 0, 'z'); a.apply(o); ops.push(...o) } // others' edits in between
  }
  const c = new Rga('c')
  c.apply(compactOps(ops))
  const ref = new Rga('r')
  ref.apply(ops)
  assert.deepStrictEqual(c.encode(), ref.encode(), 'compactOps changed the result in round ' + round)
  assert.ok(compactOps(ops).length <= ops.length)
}
{
  const a = new Rga('a')
  const ops: Op[] = []
  for (const ch of 'hello world') ops.push(...a.splice(a.text().length, 0, ch))
  assert.deepStrictEqual(compactOps(ops), [['i', 'a', 1, '', 0, 'hello world']])
  const many: Op[] = Array.from({ length: 5000 }, (_, i) => ['d', 'x', i * 2, 1] as Op)
  const [first, rest] = firstBatch(many, 1000)
  assert.ok(first.length > 0 && JSON.stringify(first).length < 1100 && first.length + rest.length === many.length)
  assert.strictEqual(firstBatch([['i', 'a', 1, '', 0, 'x'.repeat(5000)]], 1000)[0].length, 1) // one big op still goes
}

console.log('ok')
