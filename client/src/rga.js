// RGA (Replicated Growable Array) sequence CRDT, Roh et al. 2011. Mirrors Rga.cs on the server;
// see that file for the wire format. Each character is an item with a unique id (c = client, k = Lamport clock).
// Inserts reference the item they go after; concurrent inserts after the same item are ordered by descending id.

const gt = (a, c, k) => a.k !== k ? a.k > k : a.c > c
const key = (c, k) => c + ':' + k

export class Rga {
  constructor(client) {
    this.client = client
    this.clock = 0
    this.items = []
    this.byId = new Map()
    this.cache = ''
  }

  load(runs) {
    this.items = []
    this.byId.clear()
    for (const [c, k, text, del] of runs)
      for (let j = 0; j < text.length; j++) {
        const it = { c, k: k + j, ch: text[j], del: !!del }
        this.items.push(it)
        this.byId.set(key(c, it.k), it)
        if (it.k > this.clock) this.clock = it.k
      }
    this.cache = null
  }

  text() {
    if (this.cache === null) {
      let s = ''
      for (const it of this.items) if (!it.del) s += it.ch
      this.cache = s
    }
    return this.cache
  }

  visibleBefore(idx) {
    let n = 0
    for (let i = 0; i < idx; i++) if (!this.items[i].del) n++
    return n
  }

  /** Inserts one item; `hint` is the origin's index if known. Returns the new item's index, or -1 if it already existed. */
  insertOne(c, k, origin, ch, hint = -1) {
    if (this.byId.has(key(c, k))) return -1
    const items = this.items
    let idx = 0
    if (origin) {
      const o = this.byId.get(origin)
      if (!o) throw new Error('missing origin ' + origin)
      idx = (items[hint] === o ? hint : items.indexOf(o)) + 1
    }
    while (idx < items.length && gt(items[idx], c, k)) idx++
    const it = { c, k, ch, del: false }
    items.splice(idx, 0, it)
    this.byId.set(key(c, k), it)
    if (k > this.clock) this.clock = k
    return idx
  }

  /**
   * Integrates ops from another replica (idempotent).
   * Returns the resulting text changes, each { from, to, insert } relative to the text after the previous one.
   */
  apply(ops) {
    const changes = []
    let last = null
    const push = (from, to, insert) => {
      if (last && !last.insert && to === from + 1 && !insert && last.from === from) last.to++
      else if (last && last.to === last.from && insert && from === last.from + last.insert.length) last.insert += insert
      else changes.push(last = { from, to, insert })
    }
    for (const op of ops) {
      if (op[0] === 'i') {
        const [, c, k, oc, ok, text] = op
        let origin = oc ? key(oc, ok) : null
        let prevIdx = -1, prevVis = -1
        for (let j = 0; j < text.length; j++) {
          const idx = this.insertOne(c, k + j, origin, text[j], prevIdx)
          origin = key(c, k + j)
          if (idx < 0) { prevIdx = -1; continue }
          const vis = idx === prevIdx + 1 && prevVis >= 0 ? prevVis + 1 : this.visibleBefore(idx)
          push(vis, vis, text[j])
          prevIdx = idx
          prevVis = vis
        }
      } else {
        const [, c, k, n] = op
        for (let j = 0; j < n; j++) {
          const it = this.byId.get(key(c, k + j))
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

  /** Id of the visible character just before text position `pos` (null at the start): a cursor anchor that survives edits. */
  idAt(pos) {
    if (pos <= 0) return null
    let vis = 0
    for (const it of this.items) if (!it.del && ++vis === pos) return [it.c, it.k]
    return null
  }

  /** Current text position right after the item `c:k` (or after its closest visible predecessor if deleted). */
  posOf(c, k) {
    if (!c) return 0
    const it = this.byId.get(key(c, k))
    if (!it) return -1
    const idx = this.items.indexOf(it)
    return this.visibleBefore(idx) + (it.del ? 0 : 1)
  }

  /** Local edit: replace visible range [p, p+d) with `ins`. Applies it and returns the ops. */
  splice(p, d, ins) {
    const items = this.items, ops = []
    let i = 0, vis = 0, origin = null
    for (; i < items.length && vis < p; i++) if (!items[i].del) { vis++; origin = items[i] }
    let run = null
    for (let n = 0; n < d && i < items.length; i++) {
      const it = items[i]
      if (it.del) continue
      it.del = true
      n++
      if (run && run[1] === it.c && run[2] + run[3] === it.k) run[3]++
      else ops.push(run = ['d', it.c, it.k, 1])
    }
    if (ins) {
      const k = this.clock + 1
      const op = ['i', this.client, k, origin ? origin.c : '', origin ? origin.k : 0, ins]
      this.apply([op])
      ops.push(op)
    }
    this.cache = null
    return ops
  }
}

/** Single-splice diff: common prefix and suffix. */
export function diff(a, b) {
  const n = Math.min(a.length, b.length)
  let s = 0
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++
  let e = 0
  while (e < n - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++
  return { p: s, d: a.length - s - e, i: b.slice(s, b.length - e) }
}
