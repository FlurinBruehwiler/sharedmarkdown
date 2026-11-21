// GFM pipe tables: rendered as a real table while the selection is outside it, raw markdown while
// editing (like Obsidian). Every edit, including the hover toolbar's row/column operations, is a
// normal text transaction on the markdown source, so it syncs and undoes like typing.
import { StateField, EditorSelection, type EditorState, type Extension, type Line, type Range, type Text, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type Command, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { diff } from './rga'

type LinkHandler = (href: string) => void
let openLink: LinkHandler = () => {}
export const setTableLinkHandler = (fn: LinkHandler) => { openLink = fn }

// ---------- source model ----------

/** Column alignment from the delimiter row: left, center, right or default. */
type Align = '' | 'l' | 'c' | 'r'
/** A cell's content range (trimmed) and slot range (between the pipes), relative to its line. */
export interface Cell { from: number, to: number, slotFrom: number, slotTo: number }
/** A cell read from the document: also its line and text. */
interface SourceCell extends Cell { line: Line, text: string }
/** A table's source, as read by readTable. */
interface Table { from: number, to: number, lines: Line[], aligns: Align[], rows: SourceCell[][], cols: number }

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
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent)
    if (n.name === 'Table') return n.parent?.name === 'Document' ? n : null
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent)
    if (n.name === 'Table') return n.parent?.name === 'Document' ? n : null
  return null
}

/** Reads a table's source: line positions, cell texts and column alignments. */
function readTable(state: EditorState, node: SyntaxNode): Table {
  const doc = state.doc
  const first = doc.lineAt(node.from), last = doc.lineAt(node.to)
  const lines: Line[] = []
  for (let l = first.number; l <= last.number; l++) lines.push(doc.line(l))
  const cellsOf = (line: Line): SourceCell[] => splitRow(line.text).map(c => ({ ...c, line, text: line.text.slice(c.from, c.to) }))
  const header = cellsOf(lines[0])
  const aligns = lines[1] ? splitRow(lines[1].text).map(c => alignOf(lines[1].text.slice(c.from, c.to))) : []
  const rows = [header, ...lines.slice(2).map(cellsOf)]
  return { from: first.from, to: last.to, lines, aligns, rows, cols: header.length }
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
  const delim = w.map((n, c) => {
    const a = aligns[c]
    return a === 'c' ? ':' + '-'.repeat(n - 2) + ':' : a === 'r' ? '-'.repeat(n - 1) + ':' : a === 'l' ? ':' + '-'.repeat(n - 1) : '-'.repeat(n)
  })
  const body = rows.map(r => line(Array.from({ length: cols }, (_, c) => pad(r[c] ?? '', c))))
  return [body[0], line(delim), ...body.slice(1)].join('\n')
}

/** Replaces the table's text with a minimal change (keeps concurrent edits and cursors elsewhere intact). */
function rewrite(view: EditorView, t: Table, rows: string[][], aligns: Align[], selection?: TransactionSpec['selection']) {
  const old = view.state.doc.sliceString(t.from, t.to)
  const next = formatTable(rows, aligns)
  const d = diff(old, next)
  view.dispatch({ changes: { from: t.from + d.p, to: t.from + d.p + d.d, insert: d.i }, selection, userEvent: 'input.table' })
}

function deleteTable(view: EditorView, t: Table) {
  const doc = view.state.doc
  const from = t.from > 0 ? t.from - 1 : t.from, to = t.from > 0 ? t.to : Math.min(doc.length, t.to + 1)
  view.dispatch({ changes: { from, to }, userEvent: 'delete.table' })
}

const ALIGN_CYCLE: Record<Align, Align> = { '': 'l', l: 'c', c: 'r', r: '' }

type TableOp = 'addRow' | 'addCol' | 'delRow' | 'delCol' | 'align'
/** A cell position in a table: `r` counts the header as row 0. */
interface CellPos { r: number, c: number }

/** Row/column operations from the toolbar. `r` counts the header as row 0. */
function tableOp(view: EditorView, pos: number, op: TableOp, r: number, c: number): CellPos | null {
  const node = tableAt(view.state, pos)
  if (!node) return null
  const t = readTable(view.state, node)
  const rows = t.rows.map(row => row.map(x => x.text))
  const aligns = Array.from({ length: Math.max(...rows.map(x => x.length)) }, (_, i) => t.aligns[i] ?? '')
  const cols = t.cols
  r = Math.min(r, rows.length - 1)
  c = Math.min(c, cols - 1)
  switch (op) {
    case 'addRow': rows.splice(r + 1, 0, Array(cols).fill('')); r++; break
    case 'addCol': for (const row of rows) if (row.length > c) row.splice(c + 1, 0, ''); aligns.splice(c + 1, 0, ''); c++; break
    case 'delRow':
      if (rows.length === 1) { deleteTable(view, t); return null }
      rows.splice(r, 1)  // deleting the header promotes the first row
      r = Math.min(r, rows.length - 1)
      break
    case 'delCol':
      if (cols === 1) { deleteTable(view, t); return null }
      for (const row of rows) if (row.length > c) row.splice(c, 1)
      aligns.splice(c, 1)
      c = Math.min(c, cols - 2)
      break
    case 'align': aligns[c] = ALIGN_CYCLE[aligns[c] || '']; break
  }
  rewrite(view, t, rows, aligns)
  return { r, c }
}

// ---------- rendering ----------

// Inline markdown of a cell as a small, safe tree: strings, or { t, c } elements. Built from the
// syntax tree the editor already has, rendered with DOM APIs only (no HTML parsing of user text).
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

function cellSpec(state: EditorState, rowNode: SyntaxNode | null, cell: SourceCell): Inline[] {
  const from = cell.line.from + cell.from, to = cell.line.from + cell.to
  if (from === to) return []
  for (let n = rowNode?.firstChild; n; n = n.nextSibling)
    if (n.name === 'TableCell' && n.from >= from && n.to <= to) return inline(state.doc, n, from, to)
  return [cell.text]
}

function renderInline(parts: Inline[], parent: HTMLElement) {
  for (const p of parts) {
    if (typeof p === 'string') { parent.append(p); continue }
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

const TOOLS: [op: TableOp, label: string, title: string, target: 'row' | 'col'][] = [
  ['addRow', '+ Row', 'Add a row below', 'row'],
  ['addCol', '+ Column', 'Add a column to the right', 'col'],
  ['delRow', '− Row', 'Delete this row', 'row'],
  ['delCol', '− Column', 'Delete this column', 'col'],
  ['align', 'Align', 'Cycle this column’s alignment: left, center, right, default', 'col'],
]

/** What a rendered table shows: each cell's inline content, and the column alignments. */
interface TableSpec { rows: Inline[][][], aligns: Align[] }

/** The widget's root element, which carries its toolbar target and the widget currently rendering it. */
interface TableDOM extends HTMLDivElement {
  cur: CellPos
  widget: TableWidget
  tableDOM: HTMLTableElement
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
  // Header + rows, plus half a line of padding above and below standing in for the delimiter row,
  // so the rendered table is as tall as its source lines.
  override get estimatedHeight() { return (this.spec.rows.length + 1) * 26.4 }
  override ignoreEvent() { return true }

  toDOM(view: EditorView) {
    // widget and tableDOM are set by fill() below, before the element is returned.
    const wrap = document.createElement('div') as TableDOM
    wrap.className = 'cm-tbl'
    wrap.cur = { r: -1, c: -1 }
    const scroll = document.createElement('div')
    scroll.className = 'cm-tbl-scroll'
    const tools = document.createElement('div')
    tools.className = 'cm-tbl-tools'
    for (const [op, label, title, target] of TOOLS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = title
      b.tabIndex = -1
      b.onmouseenter = () => wrap.classList.add('cm-tbl-hl-' + target)
      b.onmouseleave = () => wrap.classList.remove('cm-tbl-hl-' + target)
      b.onmousedown = e => {
        e.preventDefault()
        e.stopPropagation()
        if (e.button !== 0) return
        const { r, c } = wrap.widget.current(wrap)
        const next = tableOp(view, view.posAtDOM(wrap), op, r, c)
        if (next) wrap.cur = next
      }
      tools.append(b)
    }
    wrap.append(scroll, tools)

    wrap.addEventListener('mouseover', e => {
      const td = e.target instanceof Element ? e.target.closest<HTMLTableCellElement>('td, th') : null
      if (td && wrap.contains(td)) { wrap.cur = { r: Number(td.dataset.r), c: Number(td.dataset.c) }; wrap.widget.mark(wrap) }
    })
    wrap.addEventListener('mousedown', e => {
      if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest('.cm-tbl-tools')) return
      const link = e.target.closest<HTMLElement>('.cm-tbl-link')
      e.preventDefault()
      if (link) { openLink(link.dataset.href!); return } // renderInline sets data-href on every link
      const td = e.target.closest<HTMLTableCellElement>('td, th')
      if (td) wrap.widget.edit(view, wrap, td, e)
    })
    this.fill(wrap)
    return wrap
  }

  // Re-render in place so hover state and the toolbar survive edits made through the toolbar.
  override updateDOM(dom: TableDOM) {
    this.fill(dom)
    return true
  }

  current(wrap: TableDOM): CellPos {
    const rows = this.spec.rows.length, cols = this.spec.aligns.length
    const { r, c } = wrap.cur
    return { r: r < 0 || r >= rows ? rows - 1 : r, c: c < 0 || c >= cols ? cols - 1 : c }
  }

  fill(wrap: TableDOM) {
    const scroll = wrap.firstChild as HTMLDivElement // the .cm-tbl-scroll toDOM() puts first
    const table = document.createElement('table')
    const { rows, aligns } = this.spec
    rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      for (let c = 0; c < aligns.length; c++) {
        const td = document.createElement(r === 0 ? 'th' : 'td')
        td.dataset.r = String(r)
        td.dataset.c = String(c)
        const align = aligns[c]
        if (align) td.style.textAlign = { l: 'left', c: 'center', r: 'right' }[align]
        renderInline(row[c] ?? [], td)
        tr.append(td)
      }
      table.append(tr)
    })
    scroll.replaceChildren(table)
    wrap.tableDOM = table
    wrap.widget = this
    this.mark(wrap)
  }

  // Marks the row and column the toolbar acts on (shown while hovering a toolbar button).
  mark(wrap: TableDOM) {
    const { r, c } = this.current(wrap)
    for (const td of wrap.tableDOM.querySelectorAll<HTMLTableCellElement>('th, td')) {
      td.classList.toggle('cm-tbl-r', Number(td.dataset.r) === r)
      td.classList.toggle('cm-tbl-c', Number(td.dataset.c) === c)
    }
  }

  // Click on a cell: put the cursor at the matching place in the source (which then shows for editing).
  edit(view: EditorView, wrap: TableDOM, td: HTMLTableCellElement, e: MouseEvent) {
    const node = tableAt(view.state, view.posAtDOM(wrap))
    if (!node) return
    const t = readTable(view.state, node)
    const r = Number(td.dataset.r), c = Number(td.dataset.c)
    const cell = t.rows[r]?.[c]
    let pos: number
    if (!cell) pos = (t.lines[r === 0 ? 0 : r + 1] ?? t.lines[t.lines.length - 1]).to
    else {
      pos = cell.line.from + cell.to
      if (cell.from === cell.to) pos = cell.line.from + Math.min(cell.slotFrom + 1, cell.slotTo)
      else if (td.textContent === cell.text) {
        // Plain text cell: keep the clicked character offset.
        const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY)
        const range = caret ? null : document.caretRangeFromPoint?.(e.clientX, e.clientY)
        const at = caret ? { node: caret.offsetNode, off: caret.offset } : range ? { node: range.startContainer, off: range.startOffset } : null
        if (at && td.contains(at.node) && at.node.nodeType === 3) pos = cell.line.from + cell.from + Math.min(at.off, cell.to - cell.from)
      }
    }
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: 'select.pointer' })
    view.focus()
  }
}

function buildTables(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = []
  const sel = state.selection.ranges
  for (let n: SyntaxNode | null = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== 'Table') continue
    const t = readTable(state, n)
    if (t.lines.length < 2 || sel.some(r => r.from <= t.to && r.to >= t.from)) continue
    const rowNodes = [n.getChild('TableHeader'), ...n.getChildren('TableRow')]
    const rows = t.rows.map((row, i) => {
      const cells: Inline[][] = []
      for (let c = 0; c < t.cols; c++) cells.push(row[c] ? cellSpec(state, rowNodes[i], row[c]) : [])
      return cells
    })
    const aligns = Array.from({ length: t.cols }, (_, c) => t.aligns[c] ?? '')
    decos.push(Decoration.replace({ widget: new TableWidget({ rows, aligns }), block: true }).range(t.from, t.to))
  }
  return Decoration.set(decos)
}

const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update(decos, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return buildTables(tr.state)
    return decos
  },
  provide: f => EditorView.decorations.from(f),
})

// ---------- keyboard ----------

const tableLine = (state: EditorState, line: Line) => {
  const node = tableAt(state, line.from)
  if (!node) return null
  const t = readTable(state, node)
  return line.from >= t.from && line.to <= t.to ? t : null
}

function rowTemplate(t: Table) {
  // An empty row whose cell slots line up with the delimiter row.
  const delim = t.lines[1]
  const slots = splitRow(delim.text)
  return '|' + slots.map(s => ' '.repeat(Math.max(2, s.slotTo - s.slotFrom))).join('|') + '|'
}

/** Enter: `| a | b |` on its own line becomes a table; inside a table it adds a row, or leaves on an empty one. */
export function tableEnter(view: EditorView) {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const t = tableLine(state, line)
  if (t) {
    const idx = t.lines.findIndex(l => l.number === line.number)
    const row = t.rows[idx === 0 ? 0 : idx - 1]
    if (idx >= 2 && idx === t.lines.length - 1 && row.every(c => !c.text)) {
      // Enter on an empty last row leaves the table, like on an empty list item.
      // A blank line ends the table; the cursor goes below it, so new text isn't parsed as a row.
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '\n' }, selection: { anchor: line.from + 1 }, scrollIntoView: true, userEvent: 'input' })
      return true
    }
    const after = t.lines[Math.max(idx, 1)]
    const insert = '\n' + rowTemplate(t)
    view.dispatch({ changes: { from: after.to, insert }, selection: { anchor: after.to + 3 }, scrollIntoView: true, userEvent: 'input' })
    return true
  }
  // Turn a header line into a table: needs leading and trailing pipes and the cursor at the end.
  if (sel.head !== line.to || !/^\|.*[^\\]\|\s*$/.test(line.text) || /^\|[\s|:-]*\|$/.test(line.text)) return false
  const ctx = syntaxTree(state).resolveInner(line.from, 1)
  if (ctx.name !== 'Paragraph' || ctx.parent?.name !== 'Document' || ctx.from !== line.from) return false
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : ''
  if (/^\s*\|?[\s:|-]+\|?\s*$/.test(next) && next.includes('-')) return false
  const head = splitRow(line.text).map(c => line.text.slice(c.from, c.to))
  const text = formatTable([head, head.map(() => '')], [])
  const firstCell = line.from + text.lastIndexOf('\n') + 3
  view.dispatch({ changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: firstCell }, scrollIntoView: true, userEvent: 'input' })
  return true
}

/** Tab / Shift-Tab move between cells in a table's source (selecting the cell text); Tab past the end adds a row. */
export const tableTab = (dir: number): Command => view => {
  const { state } = view
  const sel = state.selection.main
  const line = state.doc.lineAt(sel.head)
  const t = tableLine(state, line)
  if (!t) return false
  const cells: Cell[] = []
  t.lines.forEach((l, i) => { if (i !== 1) for (const c of splitRow(l.text)) cells.push({ from: l.from + c.from, to: l.from + c.to, slotFrom: l.from + c.slotFrom, slotTo: l.from + c.slotTo }) })
  let i = cells.findIndex(c => sel.head >= c.slotFrom && sel.head <= c.slotTo)
  if (i < 0) i = dir > 0 ? -1 : cells.length
  const target = cells[i + dir]
  if (!target) {
    if (dir < 0) return true
    const insert = '\n' + rowTemplate(t)
    view.dispatch({ changes: { from: t.to, insert }, selection: { anchor: t.to + 3 }, scrollIntoView: true, userEvent: 'input' })
    return true
  }
  const empty = target.from === target.to
  const at = empty ? Math.min(target.slotFrom + 1, target.slotTo) : target.from
  view.dispatch({ selection: empty ? { anchor: at } : EditorSelection.single(target.from, target.to), scrollIntoView: true, userEvent: 'select' })
  return true
}

export function tables(linkHandler?: LinkHandler): Extension {
  if (linkHandler) setTableLinkHandler(linkHandler)
  return tableField
}

/**
 * ArrowUp/Down: a rendered table is one block widget, which vertical motion would jump over.
 * Step into its first (or last) row instead, which shows the source for editing.
 */
export const tableArrow = (forward: boolean): Command => view => {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const target = view.moveVertically(sel, forward)
  const lo = Math.min(sel.head, target.head), hi = Math.max(sel.head, target.head)
  for (let n: SyntaxNode | null = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== 'Table' || n.to < lo) continue
    if (n.from > hi) break
    const t = readTable(state, n)
    if (sel.head >= t.from && sel.head <= t.to) return false
    if (forward ? t.from >= sel.head && t.from <= target.head : t.to <= sel.head && t.to >= target.head) {
      const line = forward ? t.lines[0] : t.lines[t.lines.length - 1]
      const cell = splitRow(line.text)[0]
      view.dispatch({ selection: { anchor: line.from + (cell ? cell.from : 0) }, scrollIntoView: true, userEvent: 'select' })
      return true
    }
  }
  return false
}
