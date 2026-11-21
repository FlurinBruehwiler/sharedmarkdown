// RGA (Replicated Growable Array) sequence CRDT, Roh et al. 2011. Mirrors Rga.cs on the server;
// see that file for the wire format. Each character is an item with a unique id (c = client, k = Lamport clock).
// Inserts reference the item they go after; concurrent inserts after the same item are ordered by descending id.

/** Insert run: text[j] gets id (client, clock + j); the first char goes after the origin ("" = document start). */
export type InsertOp = ['i', client: string, clock: number, originClient: string, originClock: number, text: string]
/** Delete run: tombstones (client, clock .. clock + count - 1). */
export type DeleteOp = ['d', client: string, clock: number, count: number]
export type Op = InsertOp | DeleteOp
/** Document state as runs in document order: [client, clock, text, deleted]. */
export type StateRun = [client: string, clock: number, text: string, deleted: 0 | 1]
/** An item id: [client, clock]. */
export type Id = [client: string, clock: number]
/** A text change relative to the text after the previous change. */
export interface TextChange { from: number, to: number, insert: string }

interface Item { c: string, k: number, ch: string, del: boolean }

const gt = (a: Item, c: string, k: number) => a.k !== k ? a.k > k : a.c > c
const key = (c: string, k: number) => c + ':' + k

/** Collects a change list, extending the previous change where the next one continues it (typing, deleting a range). */
class Changes {
  list: TextChange[] = []
  last: TextChange | null = null
  push(from: number, to: number, insert: string) {
    const last = this.last
    if (last && !last.insert && to === from + 1 && !insert && last.from === from) last.to++
    else if (last && last.to === last.from && insert && from === last.from + last.insert.length) last.insert += insert
    else this.list.push(this.last = { from, to, insert })
  }
}

export class Rga {
  readonly client: string
  clock = 0
  items: Item[] = []
  byId = new Map<string, Item>()
  cache: string | null = ''

  constructor(client: string) {
    this.client = client
  }

  load(runs: StateRun[]) {
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

  /** The state as runs in document order, the same format the server sends on join (Rga.cs Encode). */
  encode(): StateRun[] {
    const runs: StateRun[] = []
    let run: StateRun | null = null
    for (const it of this.items) {
      const del = it.del ? 1 : 0
      if (run && run[0] === it.c && run[1] + run[2].length === it.k && run[3] === del) run[2] += it.ch
      else runs.push(run = [it.c, it.k, it.ch, del])
    }
    return runs
  }

  text() {
    if (this.cache === null) {
      let s = ''
      for (const it of this.items) if (!it.del) s += it.ch
      this.cache = s
    }
    return this.cache
  }

  visibleBefore(idx: number) {
    let n = 0
    for (let i = 0; i < idx; i++) if (!this.items[i].del) n++
    return n
  }

  /**
   * Integrates ops from another replica (idempotent).
   * Returns the resulting text changes, each { from, to, insert } relative to the text after the previous one.
   * Deleting an unknown id is a no-op (the server drops old tombstones); an insert after an unknown origin throws.
   */
  apply(ops: Op[]): TextChange[] {
    const out = new Changes()
    try {
      for (let i = 0; i < ops.length;) {
        const op = ops[i]
        if (op[0] === 'i') { this.insert(op, out); i++; continue }
        // Consecutive deletes ("select all, delete" sends one per run of ids) take a single walk over the items.
        const dels: DeleteOp[] = []
        for (let o: Op | undefined; (o = ops[i]) && o[0] === 'd'; i++) dels.push(o)
        this.remove(dels, out)
      }
    } finally { this.cache = null }
    return out.list
  }

  /** Integrates one insert run: one walk to its origin, then the new items go in as a block. */
  insert(op: InsertOp, out: Changes) {
    const [, c, k, oc, ok, text] = op
    if (this.has(c, k, text.length)) return // already integrated (sent twice)
    let items = this.items
    // pos: index in `items` (not counting new items) before which the next character goes; vis: its text position.
    let pos = 0, vis = 0
    if (oc) {
      const o = this.byId.get(key(oc, ok))
      if (!o) throw new Error('missing origin ' + key(oc, ok))
      while (items[pos] !== o) if (!items[pos++].del) vis++
      if (!o.del) vis++
      pos++
    }
    // New items not spliced in yet, in groups that go before items[at]; almost always a single group.
    const groups: { at: number, add: Item[] }[] = []
    const flush = () => {
      for (let g = groups.length - 1; g >= 0; g--) {
        const { at, add } = groups[g]
        if (add.length < 1000) items.splice(at, 0, ...add)
        else this.items = items = items.slice(0, at).concat(add, items.slice(at))
      }
      groups.length = 0
    }
    for (let j = 0; j < text.length; j++) {
      const ck = k + j
      const existing = this.byId.get(key(c, ck))
      if (existing) {
        // Part of the run is already here (merged with ops sent before): carry on after it.
        flush()
        pos = items.indexOf(existing) + 1
        vis = this.visibleBefore(pos)
        continue
      }
      // RGA: skip items after the same origin that have a greater id.
      const start = pos
      while (pos < items.length && gt(items[pos], c, ck)) if (!items[pos++].del) vis++
      const it: Item = { c, k: ck, ch: text[j], del: false }
      const group = groups[groups.length - 1]
      if (group && pos === start) group.add.push(it)
      else groups.push({ at: pos, add: [it] })
      this.byId.set(key(c, ck), it)
      if (ck > this.clock) this.clock = ck
      out.push(vis, vis, text[j])
      vis++
    }
    flush()
  }

  /** Integrates delete runs with one walk over the items. Changes come out in document order. */
  remove(ops: DeleteOp[], out: Changes) {
    const targets = new Set<Item>()
    for (const [, c, k, n] of ops)
      for (let j = 0; j < n; j++) {
        const it = this.byId.get(key(c, k + j))
        if (it && !it.del) targets.add(it)
      }
    let left = targets.size, vis = 0, removed = 0
    for (const it of this.items) {
      if (!left) break
      if (targets.has(it)) {
        const p = vis - removed // the targets before this one are gone from the text by now
        out.push(p, p + 1, '')
        it.del = true
        removed++
        vis++
        left--
      } else if (!it.del) vis++
    }
  }

  /**
   * The text as it was before `ops` (this replica's own, unconfirmed ops): their inserted characters
   * left out, the characters they deleted shown. The base of a three-way merge (merge.ts).
   */
  textWithout(ops: Op[]) {
    const inserted = new Set<string>(), deleted = new Set<string>()
    for (const op of ops) {
      if (op[0] === 'i') for (let j = 0; j < op[5].length; j++) inserted.add(key(op[1], op[2] + j))
      else for (let j = 0; j < op[3]; j++) deleted.add(key(op[1], op[2] + j))
    }
    let s = ''
    for (const it of this.items) {
      const id = key(it.c, it.k)
      if (!inserted.has(id) && (!it.del || deleted.has(id))) s += it.ch
    }
    return s
  }

  /** Whether items (c, k .. k + n - 1) all exist (deleted or not). */
  has(c: string, k: number, n = 1) {
    for (let j = 0; j < n; j++) if (!this.byId.has(key(c, k + j))) return false
    return true
  }

  /** Id of the visible character just before text position `pos` (null at the start): a cursor anchor that survives edits. */
  idAt(pos: number): Id | null {
    if (pos <= 0) return null
    let vis = 0
    for (const it of this.items) if (!it.del && ++vis === pos) return [it.c, it.k]
    return null
  }

  /** Current text position right after the item `c:k` (or after its closest visible predecessor if deleted). */
  posOf(c: string, k: number) {
    if (!c) return 0
    const it = this.byId.get(key(c, k))
    if (!it) return -1
    const idx = this.items.indexOf(it)
    return this.visibleBefore(idx) + (it.del ? 0 : 1)
  }

  /** Local edit: replace visible range [p, p+d) with `ins`. Applies it and returns the ops. */
  splice(p: number, d: number, ins: string): Op[] {
    const items = this.items, ops: Op[] = []
    let i = 0, vis = 0
    let origin: Item | null = null
    for (; i < items.length && vis < p; i++) if (!items[i].del) { vis++; origin = items[i] }
    let run: DeleteOp | null = null
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
      const op: InsertOp = ['i', this.client, k, origin ? origin.c : '', origin ? origin.k : 0, ins]
      this.apply([op])
      ops.push(op)
    }
    this.cache = null
    return ops
  }
}

/**
 * Applies ops that may come out of causal order (unsent ops of several tabs, kept offline): retries the
 * ones whose origin is missing until nothing changes. Returns the ops in an order that applies cleanly,
 * and whether all of them did (false if some inserts go after characters that aren't there, e.g. made
 * by an op that was lost). Deletes of characters that never show up are no-ops, as on the server.
 */
export function applyAll(rga: Rga, ops: Op[]): { ok: boolean, applied: Op[] } {
  const applied: Op[] = []
  let left = ops
  while (left.length) {
    const failed: Op[] = []
    for (const op of left) {
      // A delete whose characters aren't there yet would be skipped for good: wait for their insert.
      if (op[0] === 'd' && !rga.has(op[1], op[2], op[3])) { failed.push(op); continue }
      try { rga.apply([op]); applied.push(op) } catch { failed.push(op) }
    }
    if (failed.length === left.length) {
      // Stuck. The remaining deletes delete whatever of theirs is there (the rest is gone or never comes).
      for (const op of failed) if (op[0] === 'd') { rga.apply([op]); applied.push(op) }
      return { ok: failed.every(op => op[0] === 'd'), applied }
    }
    left = failed
  }
  return { ok: true, applied }
}

/**
 * Merges adjacent ops that continue each other (typing a word gives one insert per key; a run is
 * equivalent, since each character of a run goes right after the previous one). Keeps outboxes that
 * grew offline small.
 */
export function compactOps(ops: Op[]): Op[] {
  const out: Op[] = []
  for (const op of ops) {
    const last = out[out.length - 1]
    if (last && last[0] === 'i' && op[0] === 'i' && op[1] === last[1] && op[2] === last[2] + last[5].length
      && op[3] === last[1] && op[4] === op[2] - 1) out[out.length - 1] = ['i', last[1], last[2], last[3], last[4], last[5] + op[5]]
    else if (last && last[0] === 'd' && op[0] === 'd' && op[1] === last[1] && op[2] === last[2] + last[3])
      out[out.length - 1] = ['d', last[1], last[2], last[3] + op[3]]
    else out.push(op)
  }
  return out
}

/** Splits off a first batch of ops of at most about `max` bytes of JSON (the hub refuses messages over 512 KiB). */
export function firstBatch(ops: Op[], max = 128 * 1024): [batch: Op[], rest: Op[]] {
  let size = 0, n = 0
  while (n < ops.length && (n === 0 || size + JSON.stringify(ops[n]).length <= max)) size += JSON.stringify(ops[n++]).length
  return [ops.slice(0, n), ops.slice(n)]
}
