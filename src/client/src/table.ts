// GFM pipe tables, edited like in Obsidian: the table stays rendered and you type straight into a
// cell, which shows its own markdown while you're in it. Every edit is a minimal text change on the
// markdown source (one cell's text, one line, one `| x ` segment per row), never a rewrite of the
// whole table, so collaborators editing other cells at the same time are never clobbered.
import { StateField, type ChangeSpec, type EditorState, type Extension, type Line, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type Command, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { undo, redo, isolateHistory } from '@codemirror/commands'
import type { SyntaxNode } from '@lezer/common'
import { diff } from './text'

type LinkHandler = (href: string) => void
let openLink: LinkHandler = () => {}

// ---------- source model ----------

/** Column alignment from the delimiter row: left, center, right or default. */
type Align = '' | 'l' | 'c' | 'r'
/** A cell's content range (trimmed) and slot range (between the pipes), relative to its line. */
export interface Cell { from: number, to: number, slotFrom: number, slotTo: number }
/** A cell read from the document: also its line and text. */
interface SourceCell extends Cell { line: Line, text: string }
/** A table's source. `rows[0]` is the header; the delimiter is `lines[1]`. */
interface Table { from: number, to: number, lines: Line[], aligns: Align[], delim: Cell[], rows: SourceCell[][], cols: number }
/** A rectangle of cells, inclusive; `r` counts the header as row 0. */
interface Rect { r1: number, c1: number, r2: number, c2: number }

const width = (s: string) => [...s].length

/** Cells of one table row: content range (trimmed) and slot range (between the pipes), relative to the line. */
export function splitRow(text: string): Cell[] {
  const cells: Cell[] = []
  let i = 0
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  const lead = text[i] === '|'
  if (lead) i++
  let start = i, trailingPipe = false
  const push = (end: number) => {
    let from = start, to = end
    while (from < to && /\s/.test(text[from])) from++
    while (to > from && /\s/.test(text[to - 1])) to--
    cells.push({ from, to, slotFrom: start, slotTo: end })
  }
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i++; continue }
    if (ch === '|') { push(i); start = i + 1; trailingPipe = true }
    else if (!/\s/.test(ch)) trailingPipe = false
  }
  if (!trailingPipe || !cells.length) push(text.length)
  return cells
}

const alignOf = (s: string): Align => {
  s = s.trim()
  const l = s.startsWith(':'), r = s.endsWith(':') && s.length > 1
  return l && r ? 'c' : r ? 'r' : l ? 'l' : ''
}

/** The top-level Table node at or around `pos`, or null. Tables nested in quotes/lists stay raw text. */
export function tableAt(state: EditorState, pos: number): SyntaxNode | null {
  for (const side of [1, -1] as const)
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent)
      if (n.name === 'Table') return n.parent?.name === 'Document' ? n : null
  return null
}

function readTable(state: EditorState, node: SyntaxNode): Table {
  const doc = state.doc
  const first = doc.lineAt(node.from), last = doc.lineAt(node.to)
  const lines: Line[] = []
  for (let l = first.number; l <= last.number; l++) lines.push(doc.line(l))
  const cellsOf = (line: Line): SourceCell[] => splitRow(line.text).map(c => ({ ...c, line, text: line.text.slice(c.from, c.to) }))
  const header = cellsOf(lines[0])
  const delim = lines[1] ? splitRow(lines[1].text) : []
  const aligns = delim.map(c => alignOf(lines[1].text.slice(c.from, c.to)))
  const rows = [header, ...lines.slice(2).map(cellsOf)]
  return { from: first.from, to: last.to, lines, aligns, delim, rows, cols: header.length }
}

/** Markdown for a table, columns padded to equal width and aligned like the delimiter row says. */
export function formatTable(rows: string[][], aligns: Align[]) {
  const cols = Math.max(1, ...rows.map(r => r.length))
  const w: number[] = []
  for (let c = 0; c < cols; c++) w[c] = Math.max(3, ...rows.map(r => width(r[c] ?? '')))
  const pad = (s: string, c: number) => {
    const gap = w[c] - width(s), a = aligns[c]
    if (a === 'r') return ' '.repeat(gap) + s
    if (a === 'c') return ' '.repeat(gap >> 1) + s + ' '.repeat(gap - (gap >> 1))
    return s + ' '.repeat(gap)
  }
  const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |'
  const delim = w.map((n, c) => delimFor(aligns[c] ?? '', n))
  const body = rows.map(r => line(Array.from({ length: cols }, (_, c) => pad(r[c] ?? '', c))))
  return [body[0], line(delim), ...body.slice(1)].join('\n')
}

const delimFor = (a: Align, n = 3) =>
  a === 'c' ? ':' + '-'.repeat(Math.max(1, n - 2)) + ':' : a === 'r' ? '-'.repeat(Math.max(2, n - 1)) + ':' : a === 'l' ? ':' + '-'.repeat(Math.max(2, n - 1)) : '-'.repeat(Math.max(3, n))

/** Pipes typed into a cell would split it: escape every unescaped one. */
const escapeCell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/(^|[^\\])\|/g, '$1\\|').replace(/(^|[^\\])\|/g, '$1\\|')

// ---------- minimal edits ----------

const lineOfRow = (t: Table, r: number) => t.lines[r === 0 ? 0 : r + 1]

/** The change that sets cell (r, c) to `text`: only the differing characters inside that cell. */
function cellChange(t: Table, r: number, c: number, text: string): ChangeSpec | null {
  const line = lineOfRow(t, r)
  if (!line) return null
  const cell = t.rows[r][c]
  if (!cell) {
    // A short row: append the missing cells.
    const have = t.rows[r].length
    const missing = Array.from({ length: c - have }, () => '   |').join('')
    const endsWithPipe = /\|\s*$/.test(line.text)
    return { from: line.to, insert: (endsWithPipe ? '' : ' |') + missing + ` ${text} |` }
  }
  if (cell.from === cell.to) {
    // Empty slot: keep a space on both sides of the content.
    const at = cell.slotFrom + (line.text[cell.slotFrom] === ' ' ? 1 : 0)
    const lead = line.text[cell.slotFrom] === ' ' ? '' : ' '
    const trail = at < cell.slotTo && line.text[at] === ' ' ? '' : ' '
    return text ? { from: line.from + at, insert: lead + text + trail } : null
  }
  const d = diff(cell.text, text)
  if (!d.d && !d.i) return null
  const from = line.from + cell.from + d.p
  return { from, to: from + d.d, insert: d.i }
}

/** An empty row whose cell slots line up with the delimiter row. */
function emptyRow(t: Table) {
  return '|' + Array.from({ length: t.cols }, (_, c) => ' '.repeat(Math.max(2, (t.delim[c]?.slotTo ?? 4) - (t.delim[c]?.slotFrom ?? 0)))).join('|') + '|'
}

function insertRowChange(t: Table, at: number): ChangeSpec {
  // at = index of the new row (>= 1). Insert before that row's line, or after the last line.
  const before = t.lines[at + 1]
  return before ? { from: before.from, insert: emptyRow(t) + '\n' } : { from: t.to, insert: '\n' + emptyRow(t) }
}

function deleteRowsChanges(t: Table, rows: number[]): ChangeSpec[] {
  const set = new Set(rows)
  const changes: ChangeSpec[] = []
  if (set.has(0)) {
    // The header can't go: the first remaining row becomes the header.
    const promote = t.rows.findIndex((_, i) => i > 0 && !set.has(i))
    if (promote < 0) return []
    const src = lineOfRow(t, promote)
    changes.push({ from: t.lines[0].from, to: t.lines[0].to, insert: src.text })
    set.delete(0)
    set.add(promote)
  }
  for (const r of set) {
    const line = lineOfRow(t, r)
    // Remove the line with its preceding newline (rows are never the first line of a table).
    changes.push({ from: line.from - 1, to: line.to })
  }
  return changes
}

function insertColChanges(t: Table, at: number): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  t.lines.forEach((line, i) => {
    const cells = i === 1 ? t.delim : splitRow(line.text)
    const text = i === 0 ? `Column ${t.cols + 1}` : i === 1 ? '---' : ''
    const seg = ` ${text} |`
    if (at < cells.length) changes.push({ from: line.from + cells[at].slotFrom, insert: seg })
    else if (at === cells.length) {
      const endsWithPipe = /\|\s*$/.test(line.text)
      changes.push({ from: line.to, insert: endsWithPipe ? seg : ' |' + seg })
    }
  })
  return changes
}

function deleteColsChanges(t: Table, cols: number[]): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  for (const [i, line] of t.lines.entries()) {
    const cells = i === 1 ? t.delim : splitRow(line.text)
    for (const c of cols) {
      const cell = cells[c]
      if (!cell) continue
      // The slot plus the pipe in front of it (or behind it, for a first cell without a leading pipe).
      const pipeBefore = cell.slotFrom > 0 && line.text[cell.slotFrom - 1] === '|'
      changes.push(pipeBefore
        ? { from: line.from + cell.slotFrom - 1, to: line.from + cell.slotTo }
        : { from: line.from + cell.slotFrom, to: line.from + Math.min(line.text.length, cell.slotTo + 1) })
    }
  }
  return changes
}

function swapRowsChanges(t: Table, a: number, b: number): ChangeSpec[] {
  const la = lineOfRow(t, a), lb = lineOfRow(t, b)
  return [{ from: la.from, to: la.to, insert: lb.text }, { from: lb.from, to: lb.to, insert: la.text }]
}

function swapColsChanges(t: Table, a: number, b: number): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  t.lines.forEach((line, i) => {
    const cells = i === 1 ? t.delim : splitRow(line.text)
    const ca = cells[a], cb = cells[b]
    if (!ca || !cb) return
    const ta = line.text.slice(ca.slotFrom, ca.slotTo), tb = line.text.slice(cb.slotFrom, cb.slotTo)
    changes.push({ from: line.from + ca.slotFrom, to: line.from + ca.slotTo, insert: tb }, { from: line.from + cb.slotFrom, to: line.from + cb.slotTo, insert: ta })
  })
  return changes
}

function alignChange(t: Table, c: number, a: Align): ChangeSpec | null {
  const cell = t.delim[c], line = t.lines[1]
  if (!cell || !line) return null
  const n = cell.to - cell.from
  return { from: line.from + cell.from, to: line.from + cell.to, insert: delimFor(a, n) }
}

// ---------- rendering ----------

// Inline markdown of a cell as a small, safe tree, rendered with DOM APIs only (no HTML parsing of user text).
type Inline =
  | string
  | { t: 'b' | 'i' | 's' | 'mark' | 'code', c: Inline[] }
  | { t: 'a', href: string, c: Inline[] }
  | { t: 'img', src: string, alt: string }

function inline(doc: Text, node: SyntaxNode, from: number, to: number): Inline[] {
  const out: Inline[] = []
  let pos = from
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.to <= from || c.from >= to) continue
    if (c.from > pos) out.push(doc.sliceString(pos, c.from))
    out.push(...convert(doc, c))
    pos = c.to
  }
  if (pos < to) out.push(doc.sliceString(pos, to))
  return out
}

const WRAP: { [node: string]: 'b' | 'i' | 's' | 'mark' | undefined } = { StrongEmphasis: 'b', Emphasis: 'i', Strikethrough: 's', Highlight: 'mark' }

function convert(doc: Text, n: SyntaxNode): Inline[] {
  const name = n.name
  const tag = WRAP[name]
  if (tag) return [{ t: tag, c: inline(doc, n, n.from, n.to) }]
  if (/Mark$/.test(name)) return []
  switch (name) {
    case 'Escape': return [doc.sliceString(n.from + 1, n.to)]
    case 'InlineCode': {
      const marks = n.getChildren('CodeMark')
      return [{ t: 'code', c: [doc.sliceString(marks[0]?.to ?? n.from, marks[1]?.from ?? n.to).trim()] }]
    }
    case 'Link': {
      const marks = n.getChildren('LinkMark'), url = n.getChild('URL')
      if (marks.length < 2) break
      return [{ t: 'a', href: url ? doc.sliceString(url.from, url.to) : '', c: inline(doc, n, marks[0].to, marks[1].from) }]
    }
    case 'Autolink':
    case 'URL': {
      const url = name === 'URL' ? n : n.getChild('URL')
      if (!url) break
      const href = doc.sliceString(url.from, url.to)
      return [{ t: 'a', href, c: [href] }]
    }
    case 'Image': {
      const marks = n.getChildren('LinkMark'), url = n.getChild('URL')
      if (!url) break
      return [{ t: 'img', src: doc.sliceString(url.from, url.to), alt: marks.length > 1 ? doc.sliceString(marks[0].to, marks[1].from) : '' }]
    }
  }
  return [doc.sliceString(n.from, n.to)]
}

function cellParts(state: EditorState, rowNode: SyntaxNode | null, cell: SourceCell): Inline[] {
  const from = cell.line.from + cell.from, to = cell.line.from + cell.to
  if (from === to) return []
  for (let n = rowNode?.firstChild; n; n = n.nextSibling)
    if (n.name === 'TableCell' && n.from >= from && n.to <= to) return inline(state.doc, n, from, to)
  return [cell.text]
}

function renderInline(parts: Inline[], parent: HTMLElement) {
  for (const p of parts) {
    if (typeof p === 'string') { parent.append(p.replace(/<br\s*\/?>/gi, '\n')); continue }
    if (p.t === 'img') {
      const img = document.createElement('img')
      img.src = p.src
      img.alt = p.alt
      img.className = 'cm-tbl-img'
      parent.append(img)
      continue
    }
    const el = document.createElement(p.t === 'a' ? 'span' : p.t)
    if (p.t === 'a') { el.className = 'cm-link cm-tbl-link'; el.dataset.href = p.href }
    renderInline(p.c, el)
    parent.append(el)
  }
}

/** Visible-text offset -> offset in the cell's markdown, skipping markers (`**`, `*`, `` ` ``, `==`, `~~`, `\`). */
function rawOffset(raw: string, visible: number) {
  let seen = 0, i = 0
  while (i < raw.length && seen < visible) {
    if (raw.startsWith('**', i) || raw.startsWith('==', i) || raw.startsWith('~~', i) || raw.startsWith('__', i)) { i += 2; continue }
    if (raw[i] === '`' || raw[i] === '*' || raw[i] === '_') { i++; continue }
    if (raw[i] === '\\' && i + 1 < raw.length) i++
    i++; seen++
  }
  return i
}

// ---------- the widget ----------

interface CellSpec { raw: string, parts: Inline[] }
/** What a rendered table shows. */
interface TableSpec { rows: CellSpec[][], aligns: Align[] }

/** Per-table UI state, kept on the root element so it survives re-renders. */
interface TableDOM extends HTMLDivElement {
  view: EditorView
  widget: TableWidget
  tableDOM: HTMLTableElement
  rowGrip: HTMLButtonElement
  colGrip: HTMLButtonElement
  /** The cell being edited, if any. */
  editing: { r: number, c: number } | null
  /** A rectangular selection of whole cells (drag, Shift+click, Shift+arrows). */
  rect: Rect | null
  /** Where the table started when last edited or focused, to find it again after a re-render. */
  from: number
}

/**
 * Where to put the caret after a structural edit. Kept outside the widget: when an edit changes a
 * table's lines, CodeMirror may replace the widget's element instead of updating it.
 */
let pendingFocus: { view: EditorView, from: number, r: number, c: number, caret: Caret, text?: string } | null = null
type Caret = 'start' | 'end' | 'all' | number

/**
 * The cell being typed in, as a document position (start of its slot), mapped through every change.
 * If someone else adds a row above it, the position follows the cell, where "row 2" would not.
 */
let tracked: { view: EditorView, pos: number } | null = null

function trackCell(wrap: TableDOM, r: number, c: number) {
  const t = source(wrap)
  const line = t && lineOfRow(t, r)
  const cell = line && t.rows[r]?.[c]
  tracked = line && cell ? { view: wrap.view, pos: line.from + cell.slotFrom } : null
}

/** The cell at a tracked position, as a pending focus. `text` is what the cell showed (edge spaces included). */
function focusTracked(view: EditorView, caret: Caret, text?: string) {
  if (!tracked || tracked.view !== view) return false
  const node = tableAt(view.state, tracked.pos)
  if (!node) return false
  const t = readTable(view.state, node)
  const lineIdx = t.lines.findIndex(l => tracked!.pos >= l.from && tracked!.pos <= l.to) // tracked is set: checked above
  if (lineIdx < 0 || lineIdx === 1) return false
  const r = lineIdx === 0 ? 0 : lineIdx - 1
  const rel = tracked.pos - t.lines[lineIdx].from
  const c = Math.max(0, t.rows[r].findIndex(x => rel >= x.slotFrom && rel <= x.slotTo))
  pendingFocus = { view, from: t.from, r, c, caret, text }
  return true
}

/** Focuses the pending cell in the table at (or, if it moved, nearest to) the remembered position. */
function applyPendingFocus(view: EditorView) {
  const p = pendingFocus
  if (!p || p.view !== view) return
  let best: TableDOM | null = null, dist = Infinity
  for (const w of view.dom.querySelectorAll<TableDOM>('.cm-tbl')) {
    let pos: number
    try { pos = view.posAtDOM(w) } catch { continue }
    if (Math.abs(pos - p.from) < dist) { best = w; dist = Math.abs(pos - p.from) }
  }
  if (!best) return
  pendingFocus = null
  focusCell(best, p.r, p.c, p.caret, p.text)
}

class TableWidget extends WidgetType {
  spec: TableSpec
  key: string
  constructor(spec: TableSpec) {
    super()
    this.spec = spec
    this.key = JSON.stringify(spec)
  }
  override eq(o: TableWidget) { return o.key === this.key }
  override get estimatedHeight() { return (this.spec.rows.length + 1) * 26.4 }
  override ignoreEvent() { return true }

  get rows() { return this.spec.rows.length }
  get cols() { return this.spec.aligns.length }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div') as TableDOM
    wrap.className = 'cm-tbl'
    wrap.contentEditable = 'false'
    wrap.tabIndex = -1 // receives keys while a cell rectangle is selected
    wrap.view = view
    wrap.editing = null
    wrap.rect = null
    wrap.from = 0
    const scroll = document.createElement('div')
    scroll.className = 'cm-tbl-scroll'
    const mk = (cls: string, text: string, label: string) => {
      const b = document.createElement('button')
      b.type = 'button'; b.className = cls; b.textContent = text; b.title = label; b.setAttribute('aria-label', label); b.tabIndex = -1
      return b
    }
    wrap.rowGrip = mk('cm-tbl-grip cm-tbl-grip-row', '⋮⋮', 'Row options')
    wrap.colGrip = mk('cm-tbl-grip cm-tbl-grip-col', '⋯', 'Column options')
    const addCol = mk('cm-tbl-edge cm-tbl-edge-col', '+', 'Add a column')
    const addRow = mk('cm-tbl-edge cm-tbl-edge-row', '+', 'Add a row')
    wrap.append(scroll, wrap.rowGrip, wrap.colGrip, addCol, addRow)
    attach(wrap, addCol, addRow)
    this.fill(wrap)
    return wrap
  }

  override updateDOM(dom: TableDOM) {
    dom.widget = this
    this.fill(dom)
    return true
  }

  // CodeMirror may replace this element (e.g. when someone else changes the table's rows while you
  // type in a cell). Hand the cell and caret on to whichever element renders the table next.
  override destroy(dom: TableDOM) {
    const td = cellOf(document.activeElement)
    if (!td || !dom.contains(td) || pendingFocus) return
    const view = dom.view, caret = caretOffset(td), text = td.textContent ?? ''
    // Runs after the update finished, when the tracked position has been mapped through it.
    queueMicrotask(() => { if (focusTracked(view, caret, text)) applyPendingFocus(view) })
  }

  /** Renders the spec into the element, keeping the cell being edited (and its caret) untouched. */
  fill(wrap: TableDOM) {
    wrap.widget = this
    const { rows, aligns } = this.spec
    const editable = canEdit(wrap.view)
    wrap.classList.toggle('cm-tbl-readonly', !editable)
    const old = wrap.tableDOM
    const sameShape = old && old.rows.length === rows.length && old.rows[0]?.cells.length === aligns.length
    if (!sameShape && old) {
      // Rows or columns changed (maybe by someone else) while you were typing in a cell: rebuilding
      // drops that cell, so put the caret back into it, wherever it is now, once the update is done.
      const td = cellOf(document.activeElement)
      if (td && old.contains(td) && !pendingFocus) {
        const view = wrap.view, caret = caretOffset(td), text = td.textContent ?? ''
        queueMicrotask(() => { if (focusTracked(view, caret, text)) applyPendingFocus(view) })
      }
    }
    if (!sameShape) {
      const table = document.createElement('table')
      rows.forEach((_, r) => {
        const tr = table.insertRow()
        for (let c = 0; c < aligns.length; c++) {
          const td = document.createElement(r === 0 ? 'th' : 'td')
          td.dataset.r = String(r)
          td.dataset.c = String(c)
          td.spellcheck = false
          tr.append(td)
        }
      })
      ;(wrap.firstChild as HTMLElement).replaceChildren(table) // .cm-tbl-scroll, created first in toDOM
      wrap.tableDOM = table
    }
    const active = document.activeElement
    for (const tr of wrap.tableDOM.rows) for (const td of tr.cells) {
      const r = Number(td.dataset.r), c = Number(td.dataset.c)
      const cell = rows[r]?.[c] ?? { raw: '', parts: [] }
      td.contentEditable = editable ? 'true' : 'false'
      const align = aligns[c]
      td.style.textAlign = align ? { l: 'left', c: 'center', r: 'right' }[align] : ''
      if (td === active && sameShape) {
        // Being edited: only touch it if the text changed underneath (someone else, or undo).
        // The source stores cells trimmed, so a space just typed at either end isn't a change.
        if ((td.textContent ?? '').trim() !== cell.raw) setTextKeepingCaret(td, cell.raw)
        continue
      }
      td.classList.remove('cm-tbl-raw')
      td.replaceChildren()
      renderInline(cell.parts, td)
    }
    paintRect(wrap)
    const view = wrap.view
    requestAnimationFrame(() => applyPendingFocus(view))
  }
}

function setTextKeepingCaret(td: HTMLElement, text: string) {
  const sel = getSelection()
  let at = text.length
  if (sel?.rangeCount && td.contains(sel.anchorNode)) {
    const before = document.createRange()
    before.selectNodeContents(td)
    before.setEnd(sel.anchorNode!, sel.anchorOffset) // anchorNode is set: the range count is non-zero
    const old = td.textContent ?? '', off = before.toString().length
    const d = diff(old, text)
    at = off <= d.p ? off : off >= d.p + d.d ? off - d.d + d.i.length : d.p + d.i.length
  }
  td.textContent = text
  placeCaret(td, at)
}

function placeCaret(td: HTMLElement, at: number | 'all') {
  const sel = getSelection()
  if (!sel) return
  const range = document.createRange()
  if (at === 'all') range.selectNodeContents(td)
  else {
    const node = td.firstChild
    if (node && node.nodeType === 3) range.setStart(node, Math.min(at, (node as globalThis.Text).length))
    else range.setStart(td, 0)
    range.collapse(true)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

const cellEl = (wrap: TableDOM, r: number, c: number) => wrap.tableDOM.rows[r]?.cells[c] as HTMLTableCellElement | undefined

function focusCell(wrap: TableDOM, r: number, c: number, caret: Caret = 'end', shown?: string) {
  r = Math.max(0, Math.min(wrap.widget.rows - 1, r))
  c = Math.max(0, Math.min(wrap.widget.cols - 1, c))
  const td = cellEl(wrap, r, c)
  if (!td) return
  setRect(wrap, null)
  td.focus({ preventScroll: false })
  // `shown` keeps spaces typed at the cell's edges, which the stored (trimmed) text doesn't have.
  const stored = wrap.widget.spec.rows[r][c].raw
  const raw = shown !== undefined && shown.trim() === stored ? shown : stored
  if (td.textContent !== raw) td.textContent = raw
  td.classList.add('cm-tbl-raw')
  placeCaret(td, caret === 'all' ? 'all' : caret === 'start' ? 0 : caret === 'end' ? raw.length : caret)
}

// ---------- operations ----------

/** False in a read-only view (shared view-only link): tables are shown but can't be changed. */
const canEdit = (view: EditorView) => !view.state.readOnly && view.state.facet(EditorView.editable)

/** Reads the table this widget shows, from the current document. */
function source(wrap: TableDOM): Table | null {
  const view = wrap.view
  let pos: number
  try { pos = view.posAtDOM(wrap) } catch { return null }
  const node = tableAt(view.state, pos)
  return node ? readTable(view.state, node) : null
}

type Focus = { r: number, c: number, caret: 'start' | 'end' | 'all' }

function run(wrap: TableDOM, changes: (t: Table) => ChangeSpec | ChangeSpec[] | null, focus?: Focus | null, userEvent = 'input.table') {
  if (!canEdit(wrap.view)) return
  const t = source(wrap)
  if (!t) return
  const c = changes(t)
  if (!c || (Array.isArray(c) && !c.length)) return
  const view = wrap.view
  wrap.from = t.from
  // Ops never move the table's first line, so its start position identifies it afterwards.
  pendingFocus = focus ? { view, from: t.from, ...focus } : null
  // Typing in a cell groups into undo steps as usual; every structural operation is its own step.
  const structural = userEvent !== 'input.type'
  view.dispatch({ changes: c, userEvent, annotations: structural ? isolateHistory.of('full') : [] })
  // CodeMirror has updated the DOM synchronously by now.
  applyPendingFocus(view)
}

const ops = {
  insertRow: (wrap: TableDOM, at: number, c = 0) => run(wrap, t => insertRowChange(t, Math.max(1, at)), { r: Math.max(1, at), c, caret: 'start' }),
  insertCol: (wrap: TableDOM, at: number) => run(wrap, t => insertColChanges(t, at), { r: 0, c: at, caret: 'all' }),
  deleteRows: (wrap: TableDOM, rows: number[]) => run(wrap, t => rows.length >= t.rows.length ? null : deleteRowsChanges(t, rows), null, 'delete.table'),
  deleteCols: (wrap: TableDOM, cols: number[]) => run(wrap, t => cols.length >= t.cols ? null : deleteColsChanges(t, cols), null, 'delete.table'),
  moveRow: (wrap: TableDOM, r: number, d: number) => run(wrap, t => swapRowsChanges(t, r, r + d), { r: r + d, c: 0, caret: 'end' }),
  moveCol: (wrap: TableDOM, c: number, d: number) => run(wrap, t => swapColsChanges(t, c, c + d), { r: 0, c: c + d, caret: 'end' }),
  align: (wrap: TableDOM, c: number, a: Align) => run(wrap, t => alignChange(t, c, a)),
  clear: (wrap: TableDOM, rect: Rect) => run(wrap, t => {
    const changes: ChangeSpec[] = []
    for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) {
      const ch = t.rows[r]?.[c] ? cellChange(t, r, c, '') : null
      if (ch) changes.push(ch)
    }
    return changes
  }, null, 'delete.table'),
}

// ---------- cell selection ----------

const norm = (a: { r: number, c: number }, b: { r: number, c: number }): Rect =>
  ({ r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) })

function setRect(wrap: TableDOM, rect: Rect | null) {
  wrap.rect = rect && (rect.r1 !== rect.r2 || rect.c1 !== rect.c2) ? rect : null
  paintRect(wrap)
}

function paintRect(wrap: TableDOM) {
  const rect = wrap.rect
  wrap.classList.toggle('cm-tbl-selecting', !!rect)
  if (!wrap.tableDOM) return
  for (const tr of wrap.tableDOM.rows) for (const td of tr.cells) {
    const r = Number(td.dataset.r), c = Number(td.dataset.c)
    td.classList.toggle('cm-tbl-sel', !!rect && r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2)
  }
}

/** Delete on a cell rectangle: whole rows or whole columns are removed, anything else is cleared. */
function deleteRect(wrap: TableDOM, rect: Rect) {
  const w = wrap.widget
  const fullWidth = rect.c1 === 0 && rect.c2 === w.cols - 1
  const fullHeight = rect.r1 === 0 && rect.r2 === w.rows - 1
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
  setRect(wrap, null)
  if (fullWidth && !fullHeight) return ops.deleteRows(wrap, range(rect.r1, rect.r2))
  if (fullHeight && !fullWidth) return ops.deleteCols(wrap, range(rect.c1, rect.c2))
  ops.clear(wrap, rect) // everything selected also just clears: tables aren't deleted this way
}

function copyRect(wrap: TableDOM, rect: Rect, e: ClipboardEvent) {
  const rows: string[][] = []
  for (let r = rect.r1; r <= rect.r2; r++) {
    const row: string[] = []
    for (let c = rect.c1; c <= rect.c2; c++) row.push(wrap.widget.spec.rows[r][c].raw)
    rows.push(row)
  }
  e.clipboardData?.setData('text/plain', rows.map(r => r.join('\t')).join('\n'))
  e.preventDefault()
}

// ---------- menus ----------

interface MenuItem { label?: string, sep?: true, section?: string, disabled?: boolean, danger?: boolean, check?: boolean, key?: string, run?: () => void }
let menuEl: HTMLDivElement | null = null

function closeMenu() {
  menuEl?.remove()
  menuEl = null
  document.querySelectorAll('.cm-tbl-hl').forEach(el => el.classList.remove('cm-tbl-hl'))
}

function openMenu(at: { x: number, y: number }, items: MenuItem[], back?: () => void) {
  closeMenu()
  const m = document.createElement('div')
  m.className = 'sm-menu'
  m.setAttribute('role', 'menu')
  for (const it of items) {
    if (it.sep) { m.append(document.createElement('hr')); continue }
    if (it.section) { const s = document.createElement('div'); s.className = 'sect'; s.textContent = it.section; m.append(s); continue }
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    if (it.danger) b.className = 'danger'
    b.disabled = !!it.disabled
    if (it.check !== undefined) { const s = document.createElement('span'); s.className = 'check'; s.textContent = it.check ? '✓' : ''; b.append(s) }
    b.append(it.label ?? '')
    if (it.key) { const k = document.createElement('span'); k.className = 'k'; k.textContent = it.key; b.append(k) }
    b.onmousedown = e => e.preventDefault()
    b.onclick = () => { closeMenu(); it.run?.() }
    m.append(b)
  }
  m.addEventListener('keydown', e => {
    const list = [...m.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); back?.() }
  })
  document.body.append(m)
  const w = m.offsetWidth, h = m.offsetHeight
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, at.x)) + 'px'
  m.style.top = (at.y + h + 8 > innerHeight ? Math.max(8, at.y - h - 8) : at.y) + 'px'
  menuEl = m
  m.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
}

addEventListener('mousedown', e => { if (menuEl && !(e.target instanceof Node && menuEl.contains(e.target))) closeMenu() }, true)
addEventListener('scroll', () => closeMenu(), true)

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl'

function rowItems(wrap: TableDOM, r: number): MenuItem[] {
  const w = wrap.widget, header = r === 0
  return [
    { label: 'Insert row above', disabled: header, run: () => ops.insertRow(wrap, r) },
    { label: 'Insert row below', key: `${mod} Enter`, run: () => ops.insertRow(wrap, r + 1) },
    { label: 'Move row up', disabled: r <= 1, run: () => ops.moveRow(wrap, r, -1) },
    { label: 'Move row down', disabled: header || r >= w.rows - 1, run: () => ops.moveRow(wrap, r, 1) },
    { sep: true },
    { label: header ? 'Delete header row' : 'Delete row', danger: true, disabled: w.rows <= 1, run: () => ops.deleteRows(wrap, [r]) },
  ]
}

function colItems(wrap: TableDOM, c: number): MenuItem[] {
  const w = wrap.widget, a = w.spec.aligns[c]
  return [
    { label: 'Insert column left', run: () => ops.insertCol(wrap, c) },
    { label: 'Insert column right', run: () => ops.insertCol(wrap, c + 1) },
    { label: 'Move column left', disabled: c === 0, run: () => ops.moveCol(wrap, c, -1) },
    { label: 'Move column right', disabled: c >= w.cols - 1, run: () => ops.moveCol(wrap, c, 1) },
    { sep: true },
    { label: 'Align left', check: a === 'l' || a === '', run: () => ops.align(wrap, c, 'l') },
    { label: 'Align center', check: a === 'c', run: () => ops.align(wrap, c, 'c') },
    { label: 'Align right', check: a === 'r', run: () => ops.align(wrap, c, 'r') },
    { sep: true },
    { label: 'Delete column', danger: true, disabled: w.cols <= 1, run: () => ops.deleteCols(wrap, [c]) },
  ]
}

function highlight(wrap: TableDOM, kind: 'row' | 'col' | null, i = -1) {
  for (const tr of wrap.tableDOM.rows) for (const td of tr.cells)
    td.classList.toggle('cm-tbl-hl', kind === 'row' ? Number(td.dataset.r) === i : kind === 'col' ? Number(td.dataset.c) === i : false)
}

// ---------- events ----------

function cellOf(target: EventTarget | null): HTMLTableCellElement | null {
  return target instanceof Element ? target.closest<HTMLTableCellElement>('td, th') : null
}
const posOf = (td: HTMLTableCellElement) => ({ r: Number(td.dataset.r), c: Number(td.dataset.c) })

function caretOffset(td: HTMLElement) {
  const sel = getSelection()
  if (!sel?.rangeCount || !td.contains(sel.anchorNode)) return 0
  const range = document.createRange()
  range.selectNodeContents(td)
  range.setEnd(sel.anchorNode!, sel.anchorOffset) // anchorNode exists: the range count is non-zero
  return range.toString().length
}

/**
 * Leaves the table: puts the editor cursor on the line above or below it. Below, there must be a
 * blank line between the table and the cursor, or what you type would become another table row.
 */
function leave(wrap: TableDOM, dir: -1 | 1) {
  const t = source(wrap)
  const view = wrap.view
  if (!t) return
  wrap.editing = null
  setRect(wrap, null)
  const doc = view.state.doc
  const last = doc.lineAt(t.to)
  if (dir < 0) {
    if (t.from === 0) view.dispatch({ changes: { from: 0, insert: '\n' }, selection: { anchor: 0 } })
    else view.dispatch({ selection: { anchor: t.from - 1 }, scrollIntoView: true })
  } else {
    // The line right after a table is always blank (text there would be a row); the cursor goes to
    // the line after that, which is only created when the table ends the document.
    const blank = last.number < doc.lines ? doc.line(last.number + 1) : null
    const after = blank && blank.number < doc.lines ? doc.line(blank.number + 1) : null
    if (after) view.dispatch({ selection: { anchor: after.from }, scrollIntoView: true })
    else if (blank) view.dispatch({ changes: { from: blank.to, insert: '\n' }, selection: { anchor: blank.to + 1 }, scrollIntoView: true })
    else view.dispatch({ changes: { from: last.to, insert: '\n\n' }, selection: { anchor: last.to + 2 }, scrollIntoView: true })
  }
  view.focus()
}

function attach(wrap: TableDOM, addCol: HTMLButtonElement, addRow: HTMLButtonElement) {
  const view = wrap.view
  let dragFrom: { r: number, c: number } | null = null
  let gripRow = 0, gripCol = 0

  const placeGrips = (r: number, c: number) => {
    const td = cellEl(wrap, r, c), tr = td?.parentElement
    if (!td || !tr) return
    const box = wrap.getBoundingClientRect(), cell = td.getBoundingClientRect(), row = tr.getBoundingClientRect(), table = wrap.tableDOM.getBoundingClientRect()
    gripRow = r; gripCol = c
    wrap.rowGrip.style.top = row.top - box.top + row.height / 2 - 12 + 'px'
    wrap.rowGrip.style.left = table.left - box.left - 22 + 'px'
    wrap.colGrip.style.left = cell.left - box.left + cell.width / 2 - 13 + 'px'
    wrap.colGrip.style.top = table.top - box.top - 18 + 'px'
    wrap.classList.add('cm-tbl-grips')
  }

  wrap.addEventListener('mouseover', e => {
    const td = cellOf(e.target)
    if (td && wrap.contains(td)) { const p = posOf(td); placeGrips(p.r, p.c) }
  })
  wrap.addEventListener('mouseleave', () => {
    if (wrap.editing) placeGrips(wrap.editing.r, wrap.editing.c)
    else if (!menuEl) wrap.classList.remove('cm-tbl-grips')
  })

  wrap.rowGrip.onmousedown = wrap.colGrip.onmousedown = e => e.preventDefault()
  wrap.rowGrip.onclick = () => {
    const b = wrap.rowGrip.getBoundingClientRect(), r = gripRow
    openMenu({ x: b.left, y: b.bottom + 4 }, rowItems(wrap, r), () => focusCell(wrap, r, 0))
    highlight(wrap, 'row', r)
  }
  wrap.colGrip.onclick = () => {
    const b = wrap.colGrip.getBoundingClientRect(), c = gripCol
    openMenu({ x: b.left, y: b.bottom + 4 }, colItems(wrap, c), () => focusCell(wrap, 0, c))
    highlight(wrap, 'col', c)
  }
  wrap.rowGrip.onmouseenter = () => highlight(wrap, 'row', gripRow)
  wrap.colGrip.onmouseenter = () => highlight(wrap, 'col', gripCol)
  wrap.rowGrip.onmouseleave = wrap.colGrip.onmouseleave = () => { if (!menuEl) highlight(wrap, null) }
  addCol.onmousedown = addRow.onmousedown = e => e.preventDefault()
  addCol.onclick = () => ops.insertCol(wrap, wrap.widget.cols)
  addRow.onclick = () => ops.insertRow(wrap, wrap.widget.rows)

  wrap.addEventListener('contextmenu', e => {
    const td = cellOf(e.target)
    if (!td) return
    e.preventDefault()
    const { r, c } = posOf(td)
    openMenu({ x: e.clientX, y: e.clientY }, [{ section: 'Row' }, ...rowItems(wrap, r), { sep: true }, { section: 'Column' }, ...colItems(wrap, c)])
  })

  wrap.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    const td = cellOf(e.target)
    if (!td || !wrap.contains(td)) return
    const p = posOf(td)
    const link = e.target instanceof Element ? e.target.closest<HTMLElement>('.cm-tbl-link') : null
    if (link && !td.classList.contains('cm-tbl-raw')) { e.preventDefault(); openLink(link.dataset.href!); return } // renderInline sets data-href
    if (e.shiftKey && wrap.editing) { e.preventDefault(); setRect(wrap, norm(wrap.editing, p)); wrap.focus(); return }
    dragFrom = p
  })
  wrap.addEventListener('mousemove', e => {
    if (!dragFrom || !(e.buttons & 1)) { dragFrom = null; return }
    const td = cellOf(e.target)
    if (!td) return
    const p = posOf(td)
    if (p.r === dragFrom.r && p.c === dragFrom.c && !wrap.rect) return
    // Dragging across cells selects a rectangle of cells instead of text.
    e.preventDefault()
    getSelection()?.removeAllRanges()
    setRect(wrap, norm(dragFrom, p))
    if (wrap.rect) wrap.focus({ preventScroll: true })
  })
  addEventListener('mouseup', () => { dragFrom = null })

  wrap.addEventListener('focusin', e => {
    const td = cellOf(e.target)
    if (!td) return
    const p = posOf(td)
    wrap.editing = p
    try { wrap.from = wrap.view.posAtDOM(wrap) } catch { /* not attached */ }
    trackCell(wrap, p.r, p.c)
    if (!td.classList.contains('cm-tbl-raw')) {
      // Switch the cell to its markdown, keeping the caret where it was clicked.
      const visible = caretOffset(td)
      const raw = wrap.widget.spec.rows[p.r]?.[p.c]?.raw ?? ''
      td.textContent = raw
      td.classList.add('cm-tbl-raw')
      placeCaret(td, rawOffset(raw, visible))
    }
    placeGrips(p.r, p.c)
  })
  wrap.addEventListener('focusout', e => {
    const td = cellOf(e.target)
    if (!td) return
    const { r, c } = posOf(td)
    const cell = wrap.widget.spec.rows[r]?.[c]
    td.classList.remove('cm-tbl-raw')
    td.replaceChildren()
    renderInline(cell?.parts ?? [], td)
    if (!wrap.contains(e.relatedTarget as Node | null)) { wrap.editing = null; if (!menuEl) wrap.classList.remove('cm-tbl-grips') }
  })

  wrap.addEventListener('input', e => {
    const td = cellOf(e.target)
    if (!td) return
    const { r, c } = posOf(td)
    const typed = td.textContent ?? ''
    const text = escapeCell(typed)
    if (text !== typed) setTextKeepingCaret(td, text)
    run(wrap, t => cellChange(t, r, c, text), null, 'input.type')
    trackCell(wrap, r, c)
  })

  wrap.addEventListener('paste', e => {
    const td = cellOf(e.target)
    if (!td) return
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    document.execCommand('insertText', false, text.replace(/\r?\n/g, ' '))
  })
  wrap.addEventListener('copy', e => { if (wrap.rect) copyRect(wrap, wrap.rect, e) })
  wrap.addEventListener('cut', e => { if (wrap.rect) { copyRect(wrap, wrap.rect, e); ops.clear(wrap, wrap.rect); setRect(wrap, null) } })

  wrap.addEventListener('keydown', e => onKey(wrap, e))
}

function wrapInCell(td: HTMLElement, marker: string) {
  const sel = getSelection()
  const text = sel?.toString() ?? ''
  document.execCommand('insertText', false, marker + text + marker)
  if (!text) placeCaret(td, caretOffset(td) - marker.length)
}

function onKey(wrap: TableDOM, e: KeyboardEvent) {
  const w = wrap.widget
  const modKey = isMac ? e.metaKey : e.ctrlKey

  // A selected rectangle of cells.
  if (wrap.rect) {
    const rect = wrap.rect
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteRect(wrap, rect); return }
    if (e.key === 'Escape') { e.preventDefault(); setRect(wrap, null); focusCell(wrap, rect.r1, rect.c1); return }
    if (e.shiftKey && e.key.startsWith('Arrow')) {
      e.preventDefault()
      const anchor = wrap.editing ?? { r: rect.r1, c: rect.c1 }
      const far = { r: anchor.r === rect.r1 ? rect.r2 : rect.r1, c: anchor.c === rect.c1 ? rect.c2 : rect.c1 }
      far.r = Math.max(0, Math.min(w.rows - 1, far.r + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0)))
      far.c = Math.max(0, Math.min(w.cols - 1, far.c + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0)))
      setRect(wrap, norm(anchor, far))
      if (!wrap.rect) focusCell(wrap, anchor.r, anchor.c)
      return
    }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); setRect(wrap, null); focusCell(wrap, rect.r1, rect.c1); return }
    if (modKey && (e.key === 'c' || e.key === 'x')) return // copy/cut events handle it
    if (e.key.length === 1 && !modKey) { e.preventDefault(); return }
    return
  }

  const td = cellOf(e.target)
  if (!td) return
  const { r, c } = posOf(td)
  const text = td.textContent ?? ''
  const at = caretOffset(td)
  const sel = getSelection()
  const collapsed = !sel || sel.isCollapsed
  const go = (nr: number, nc: number, caret: Caret = 'end') => { e.preventDefault(); focusCell(wrap, nr, nc, caret) }

  if (modKey && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(wrap.view); return }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(wrap.view); return }
    if (k === 'b') { e.preventDefault(); wrapInCell(td, '**'); return }
    if (k === 'i') { e.preventDefault(); wrapInCell(td, '*'); return }
    if (k === 'h' && e.shiftKey) { e.preventDefault(); wrapInCell(td, '=='); return }
    if (e.key === 'Enter') { e.preventDefault(); ops.insertRow(wrap, r + 1, c); return }
    if (k === 'a') { e.preventDefault(); placeCaret(td, 'all'); return }
  }
  switch (e.key) {
    case 'Tab':
      if (!e.shiftKey) {
        if (c < w.cols - 1) return go(r, c + 1, 'all')
        if (r < w.rows - 1) return go(r + 1, 0, 'all')
        e.preventDefault(); ops.insertRow(wrap, w.rows, 0); return
      }
      if (c > 0) return go(r, c - 1, 'all')
      if (r > 0) return go(r - 1, w.cols - 1, 'all')
      e.preventDefault(); return
    case 'Enter':
      e.preventDefault()
      if (e.shiftKey) { document.execCommand('insertText', false, '<br>'); return }
      if (r < w.rows - 1) return go(r + 1, c)
      ops.insertRow(wrap, w.rows, c)
      return
    case 'ArrowUp':
      if (e.shiftKey) { e.preventDefault(); setRect(wrap, norm({ r, c }, { r: Math.max(0, r - 1), c })); if (wrap.rect) wrap.focus(); return }
      if (r > 0) return go(r - 1, c, Math.min(at, w.spec.rows[r - 1][c].raw.length))
      e.preventDefault(); leave(wrap, -1); return
    case 'ArrowDown':
      if (e.shiftKey) { e.preventDefault(); setRect(wrap, norm({ r, c }, { r: Math.min(w.rows - 1, r + 1), c })); if (wrap.rect) wrap.focus(); return }
      if (r < w.rows - 1) return go(r + 1, c, Math.min(at, w.spec.rows[r + 1][c].raw.length))
      e.preventDefault(); leave(wrap, 1); return
    case 'ArrowLeft':
      if (e.shiftKey && at === 0 && collapsed && c > 0) { e.preventDefault(); setRect(wrap, norm({ r, c }, { r, c: c - 1 })); if (wrap.rect) wrap.focus(); return }
      if (at === 0 && collapsed && !e.shiftKey) {
        if (c > 0) return go(r, c - 1, 'end')
        if (r > 0) return go(r - 1, w.cols - 1, 'end')
      }
      return
    case 'ArrowRight':
      if (e.shiftKey && at === text.length && collapsed && c < w.cols - 1) { e.preventDefault(); setRect(wrap, norm({ r, c }, { r, c: c + 1 })); if (wrap.rect) wrap.focus(); return }
      if (at === text.length && collapsed && !e.shiftKey) {
        if (c < w.cols - 1) return go(r, c + 1, 'start')
        if (r < w.rows - 1) return go(r + 1, 0, 'start')
      }
      return
    case 'Escape':
      e.preventDefault(); leave(wrap, 1); return
  }
}

// ---------- decorations ----------

function buildTables(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = []
  for (let n: SyntaxNode | null = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== 'Table') continue
    const t = readTable(state, n)
    if (t.lines.length < 2) continue
    const rowNodes = [n.getChild('TableHeader'), ...n.getChildren('TableRow')]
    const rows = t.rows.map((row, i) => Array.from({ length: t.cols }, (_, c): CellSpec =>
      row[c] ? { raw: row[c].text, parts: cellParts(state, rowNodes[i], row[c]) } : { raw: '', parts: [] }))
    const aligns = Array.from({ length: t.cols }, (_, c) => t.aligns[c] ?? '')
    decos.push(Decoration.replace({ widget: new TableWidget({ rows, aligns }), block: true }).range(t.from, t.to))
  }
  return Decoration.set(decos)
}

const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update(decos, tr) {
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return buildTables(tr.state)
    return decos
  },
  provide: f => EditorView.decorations.from(f),
})

// ---------- keyboard outside tables ----------

/** Enter at the end of a line like `| a | b |` turns it into a table. */
export function tableEnter(view: EditorView) {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.to || !/^\|.*[^\\]\|\s*$/.test(line.text) || /^\|[\s|:-]*\|$/.test(line.text)) return false
  const ctx = syntaxTree(state).resolveInner(line.from, 1)
  if (ctx.name !== 'Paragraph' || ctx.parent?.name !== 'Document' || ctx.from !== line.from) return false
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : ''
  if (/^\s*\|?[\s:|-]+\|?\s*$/.test(next) && next.includes('-')) return false
  const head = splitRow(line.text).map(c => line.text.slice(c.from, c.to))
  insertTable(view, line.from, line.to, [head, head.map(() => '')], { r: 1, c: 0 })
  return true
}

/** Inserts a table (replacing from..to) and puts the caret into a cell of the rendered table. */
export function insertTable(view: EditorView, from: number, to: number, rows: string[][], focus = { r: 0, c: 0 }) {
  const doc = view.state.doc
  // A table needs a blank line before it (after a paragraph) and after it (or the next line becomes a row).
  const before = doc.lineAt(from), after = doc.lineAt(to)
  const lead = before.number > 1 && doc.line(before.number - 1).text.trim() && from === before.from ? '\n' : ''
  const trail = after.number < doc.lines && doc.line(after.number + 1).text.trim() ? '\n' : ''
  const start = from + lead.length
  pendingFocus = { view, from: start, r: focus.r, c: focus.c, caret: 'all' }
  view.dispatch({ changes: { from, to, insert: lead + formatTable(rows, []) + trail }, scrollIntoView: true, userEvent: 'input' })
  applyPendingFocus(view)
}

/** ArrowUp/Down into a rendered table: focus its first (or last) row's first cell. */
export const tableArrow = (forward: boolean): Command => view => {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const next = forward ? line.number + 1 : line.number - 1
  if (next < 1 || next > state.doc.lines) return false
  const target = state.doc.line(next)
  const node = tableAt(state, target.from)
  if (!node) return false
  for (const w of view.dom.querySelectorAll<TableDOM>('.cm-tbl')) {
    let pos: number
    try { pos = view.posAtDOM(w) } catch { continue }
    if (pos >= node.from && pos <= node.to) { focusCell(w, forward ? 0 : w.widget.rows - 1, 0, 'end'); return true }
  }
  return false
}

const trackEdits = EditorView.updateListener.of(u => {
  if (tracked && tracked.view === u.view && u.docChanged) tracked.pos = u.changes.mapPos(tracked.pos, 1)
})

export function tables(linkHandler?: LinkHandler): Extension {
  if (linkHandler) openLink = linkHandler
  return [tableField, trackEdits]
}
