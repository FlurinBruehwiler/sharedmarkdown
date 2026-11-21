// Generates src/SharedMarkdown.Tests/fixtures/rga.json: random multi-client editing sessions as the server
// would receive them (op batches in arrival order, including resends and deletes of unknown ids), plus the
// state and text the TypeScript RGA ends up with. The .NET tests replay the batches through Rga.cs and
// require the same result, so the two implementations integrate identically.
//
// Regenerate after changing rga.ts (from src/client):
//   npx esbuild test/make-rga-fixtures.ts --bundle --platform=node --format=esm --outfile=test/.out/make-rga-fixtures.mjs && node test/.out/make-rga-fixtures.mjs
//
// Uses only Rga's stable surface (constructor, splice, apply, encode, text), so it keeps working when the
// internals change. Deterministic: the same rga.ts gives the same file.
import { Rga, type Op } from '../src/rga'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let seed = 7
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
// BMP characters only: a surrogate pair split by a random delete can't round-trip through JSON in .NET.
const alphabet = 'abcdefgh xyz\nä€中#*'
const text = (max: number) => Array.from({ length: 1 + rnd(max) }, () => alphabet[rnd(alphabet.length)]).join('')
// Mixed-case names: ties in clock are broken by ordinal string comparison, which both sides must agree on.
const names = ['c0', 'C1', 'c10', 'b', 'B']

interface Case { batches: Op[][], state: unknown, text: string }
const cases: Case[] = []

for (let round = 0; round < 80; round++) {
  const server = new Rga('server')
  const batches: Op[][] = []
  const n = 2 + rnd(3)
  const clients = Array.from({ length: n }, (_, i) => ({ rga: new Rga(names[(round + i) % names.length] + (i >= names.length ? i : '')), queue: [] as Op[][], inbox: [] as Op[][] }))
  const arrive = (from: typeof clients[number], batch: Op[]) => {
    server.apply(batch)
    batches.push(batch)
    for (const o of clients) if (o !== from) o.inbox.push(batch)
  }
  const steps = 20 + rnd(60)
  for (let step = 0; step < steps; step++) {
    const c = clients[rnd(n)]
    switch (rnd(6)) {
      case 0: case 1: { // local edit: typing, deleting, replacing
        const t = c.rga.text()
        const p = rnd(t.length + 1), d = rnd(Math.min(4, t.length - p) + 1)
        c.queue.push(c.rga.splice(p, d, rnd(4) ? text(rnd(5) ? 4 : 40) : ''))
        break
      }
      case 2: { // several edits at once (offline, or a slow connection), sent as one batch
        const ops: Op[] = []
        for (let k = 1 + rnd(5); k > 0; k--) {
          const t = c.rga.text()
          const p = rnd(t.length + 1)
          ops.push(...c.rga.splice(p, rnd(Math.min(3, t.length - p) + 1), text(6)))
        }
        c.queue.push(ops)
        break
      }
      case 3: case 4: { // the client's oldest batch reaches the server; sometimes it is sent twice (reconnect)
        const batch = c.queue.shift()
        if (!batch) break
        arrive(c, batch)
        if (!rnd(8)) arrive(c, batch)
        break
      }
      case 5: { // client receives relayed ops
        const batch = c.inbox.shift()
        if (batch) c.rga.apply(batch)
        break
      }
    }
    // Now and then a delete of ids that don't exist (e.g. tombstones dropped by compaction): a no-op.
    if (!rnd(40)) arrive(clients[0], [['d', 'gone', 1 + rnd(1000), 1 + rnd(5)]])
  }
  for (const c of clients) while (c.queue.length) arrive(c, c.queue.shift()!)
  cases.push({ batches, state: server.encode(), text: server.text() })
}

if (!existsSync('src/rga.ts')) throw new Error('run this from src/client')
const out = resolve('../SharedMarkdown.Tests/fixtures/rga.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ generator: 'src/client/test/make-rga-fixtures.ts', cases }) + '\n')
console.log(`wrote ${cases.length} cases to ${out}`)
