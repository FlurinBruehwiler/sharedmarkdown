// Randomized convergence test: N clients edit concurrently; a simulated server applies
// submitted batches in arrival order and relays them, like DocHub does.
import { Rga } from '../src/rga.js'
import assert from 'node:assert'

let seed = 1
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
const word = () => 'abcdefgh'.slice(0, 1 + rnd(4))

for (let round = 0; round < 300; round++) {
  const server = new Rga('server')
  const clients = [0, 1, 2].map(i => ({ rga: new Rga('c' + i), queue: [], inbox: [] }))
  const log = []
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
  for (const c of clients) while (c.queue.length) { const b = c.queue.shift(); server.apply(b); for (const o of clients) if (o !== c) o.inbox.push(b) }
  for (const c of clients) while (c.inbox.length) c.rga.apply(c.inbox.shift())
  for (const c of clients) assert.strictEqual(c.rga.text(), server.text(), 'diverged in round ' + round)
}

// apply() must report changes that turn the old text into the new one.
for (let round = 0; round < 200; round++) {
  const a = new Rga('a'), b = new Rga('b')
  for (let step = 0; step < 30; step++) {
    const r = rnd(2) ? a : b, other = r === a ? b : a
    const t = r.rga ? '' : r.text()
    const p = rnd(t.length + 1), d = rnd(Math.min(4, t.length - p) + 1)
    const ops = r.splice(p, d, rnd(3) ? word() : '')
    let text = other.text()
    for (const ch of other.apply(ops)) text = text.slice(0, ch.from) + ch.insert + text.slice(ch.to)
    assert.strictEqual(text, other.text(), 'change list wrong in round ' + round)
    assert.strictEqual(a.text(), b.text())
    const pos = rnd(a.text().length + 1), id = a.idAt(pos)
    assert.strictEqual(a.posOf(...(id || ['', 0])), pos)
  }
}
console.log('ok')
