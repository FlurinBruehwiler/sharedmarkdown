// Plain-text helpers: diffs and a three-way merge. No editor or CRDT types here.

/** One splice: replace `d` characters at `p` with `i`. */
export interface Splice { p: number, d: number, i: string }
/** Replace [from, to) with `insert`. A list of edits is sorted and non-overlapping, in the coordinates of the original text. */
export interface Edit { from: number, to: number, insert: string }

/** Single-splice diff: common prefix and suffix. Cheap, but one splice covers everything in between. */
export function diff(a: string, b: string): Splice {
  const n = Math.min(a.length, b.length)
  let s = 0
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++
  let e = 0
  while (e < n - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++
  return { p: s, d: a.length - s - e, i: b.slice(s, b.length - e) }
}

/** A changed region: a[aFrom, aTo) became b[bFrom, bTo). */
type Hunk = [aFrom: number, aTo: number, bFrom: number, bTo: number]

/**
 * Myers' O(ND) diff of two sequences given by length and an equality test. Returns the changed
 * regions in order, or null if more than `maxD` single insertions/deletions would be needed.
 */
function myers(n: number, m: number, eq: (i: number, j: number) => boolean, maxD: number): Hunk[] | null {
  const max = n + m, off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = [] // trace[d]: v[k] for k in -d..d, at index k + d
  let end = -1
  for (let d = 0; d <= Math.min(max, maxD) && end < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && eq(x, y)) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) { end = d; break }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }
  if (end < 0) return null
  // Walk back through the trace, collecting single edits from the end.
  const edits: [del: boolean, x: number, y: number][] = []
  let x = n, y = m
  for (let d = end; d > 0; d--) {
    const prev = trace[d - 1], at = (k: number) => prev[k + d - 1]
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const pk = down ? k + 1 : k - 1
    const px = at(pk), py = px - pk
    edits.push([!down, px, py]) // down: b[py] inserted at a-position px; else a[px] deleted
    x = px; y = py
  }
  const hunks: Hunk[] = []
  for (let i = edits.length - 1; i >= 0; i--) {
    const [del, ex, ey] = edits[i]
    const last = hunks[hunks.length - 1]
    if (last && last[1] === ex && last[3] === ey) del ? last[1]++ : last[3]++
    else hunks.push(del ? [ex, ex + 1, ey, ey] : [ex, ex, ey, ey + 1])
  }
  return hunks
}

/** Lines of `s`, each with its line break. */
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? []

/**
 * A minimal-ish diff as a list of edits turning `a` into `b`: by lines first, then by characters
 * inside each changed block of lines (if it's small enough to be worth it). Falls back to coarser
 * edits when the texts are very different, so it stays fast on large documents.
 */
export function diffText(a: string, b: string): Edit[] {
  const { p, d, i } = diff(a, b)
  if (!d && !i) return []
  const as = a.slice(p, p + d), bs = i
  const la = lines(as), lb = lines(bs)
  // Interned line ids, so comparing lines is comparing numbers.
  const ids = new Map<string, number>()
  const id = (l: string) => { let n = ids.get(l); if (n === undefined) ids.set(l, n = ids.size); return n }
  const ia = la.map(id), ib = lb.map(id)
  const lineHunks = myers(ia.length, ib.length, (x, y) => ia[x] === ib[y], 2000) ?? [[0, ia.length, 0, ib.length]]
  // Line index -> character offset within as / bs.
  const offsets = (ls: string[]) => { const o = [0]; for (const l of ls) o.push(o[o.length - 1] + l.length); return o }
  const oa = offsets(la), ob = offsets(lb)
  const out: Edit[] = []
  for (const [a1, a2, b1, b2] of lineHunks) {
    const af = oa[a1], at = oa[a2], bf = ob[b1], bt = ob[b2]
    const x = as.slice(af, at), y = bs.slice(bf, bt)
    const chars = x.length + y.length <= 4000 ? myers(x.length, y.length, (i, j) => x.charCodeAt(i) === y.charCodeAt(j), 400) : null
    if (!chars) { out.push({ from: p + af, to: p + at, insert: y }); continue }
    for (const [c1, c2, d1, d2] of chars) out.push({ from: p + af + c1, to: p + af + c2, insert: y.slice(d1, d2) })
  }
  return out
}

/** Applies sorted, non-overlapping edits (back to front, so equal positions keep their order). */
export function applyEdits(text: string, edits: Edit[]) {
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]
    text = text.slice(0, e.from) + e.insert + text.slice(e.to)
  }
  return text
}

/**
 * Three-way merge: the edits that bring this device's changes (`base` -> `ours`) into `theirs`
 * (`base` plus other people's changes), in `theirs`' coordinates; apply them with applyEdits.
 *
 * Changes that don't touch the same text both survive. Where they overlap, nobody's text is lost:
 * their version of the region is kept and our inserted text goes right after it (only our deletions
 * inside the overlap are dropped). When both inserted at the same point, theirs comes first.
 */
export function merge3(base: string, ours: string, theirs: string): Edit[] {
  const mine = diffText(base, ours), others = diffText(base, theirs)
  const delta = (t: Edit) => t.insert.length - (t.to - t.from)
  // Position in theirs of base position p: after their edits that end at or before p (inserts at p included).
  const before = (p: number) => { let s = p; for (const t of others) if (t.to <= p) s += delta(t); else break; return s }
  // Same, for the end of a range: their inserts exactly at p stay outside it.
  const beforeEnd = (p: number) => { let s = p; for (const t of others) if (t.to <= p && t.from < p) s += delta(t); else if (t.from >= p) break; return s }
  const overlaps = (h: Edit, t: Edit) =>
    h.from === h.to ? t.from < h.from && h.from < t.to
      : t.from === t.to ? h.from < t.from && t.from < h.to
        : t.from < h.to && h.from < t.to
  const out: Edit[] = []
  for (const h of mine) {
    const hit = others.filter(t => overlaps(h, t))
    if (!hit.length) {
      const from = before(h.from)
      out.push({ from, to: h.from === h.to ? from : beforeEnd(h.to), insert: h.insert })
      continue
    }
    if (!h.insert) continue // a deletion of text someone else changed: theirs wins
    const at = beforeEnd(Math.max(h.to, ...hit.map(t => t.to)))
    out.push({ from: at, to: at, insert: h.insert })
  }
  return out
}
