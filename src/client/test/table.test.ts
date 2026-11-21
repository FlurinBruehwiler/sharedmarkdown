// Table source model (table.ts): parsing rows and the minimal text changes the widget makes.
import { test } from 'node:test'
import assert from 'node:assert'
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state'
import {
  splitRow, readTable, escapeCell, cellChange, insertColChanges, deleteColsChanges, insertRowChange, deleteRowsChanges,
  swapColsChanges, alignChange, formatTable, rawOffset, blankBefore, cellShown, cellStored, copiedCells,
} from '../src/table'

const doc = (...lines: string[]) => Text.of(lines)
const table = (d: Text) => readTable(d, 0, d.length)
const apply = (d: Text, spec: ChangeSpec | null) => spec ? ChangeSet.of(spec, d.length).apply(d).toString() : d.toString()
const cells = (row: string) => splitRow(row).map(c => row.slice(c.from, c.to))

test('splitRow: cells, edge pipes, escaped pipes', () => {
  assert.deepStrictEqual(cells('| a | b |'), ['a', 'b'])
  assert.deepStrictEqual(cells('a | b'), ['a', 'b'])
  assert.deepStrictEqual(cells('| a \\| b | c |'), ['a \\| b', 'c'])
  assert.deepStrictEqual(cells('|  | x |'), ['', 'x'])
  assert.deepStrictEqual(cells('| a | b'), ['a', 'b'])
  const [first] = splitRow('|  ab  |')
  assert.deepStrictEqual(first, { from: 3, to: 5, slotFrom: 1, slotTo: 7 })
})

test('readTable: header, alignments, rows', () => {
  const t = table(doc('| a | b | c |', '|:--|:-:|--:|', '| 1 | 2 |'))
  assert.strictEqual(t.cols, 3)
  assert.deepStrictEqual(t.aligns, ['l', 'c', 'r'])
  assert.deepStrictEqual(t.rows.map(r => r.map(c => c.text)), [['a', 'b', 'c'], ['1', '2']])
})

test('escapeCell escapes every unescaped pipe, adjacent ones too', () => {
  assert.strictEqual(escapeCell('a|b'), 'a\\|b')
  assert.strictEqual(escapeCell('a||b'), 'a\\|\\|b')
  assert.strictEqual(escapeCell('|x|'), '\\|x\\|')
  assert.strictEqual(escapeCell('a\\|b'), 'a\\|b')
  assert.strictEqual(escapeCell('two\nlines'), 'two lines')
})

test('cellChange only touches the differing characters', () => {
  const d = doc('| name | value |', '|---|---|', '| alpha | 1 |')
  const spec = cellChange(table(d), 1, 0, 'alphabet')
  assert.deepStrictEqual(spec, { from: d.line(3).from + 7, to: d.line(3).from + 7, insert: 'bet' })
  assert.strictEqual(apply(d, spec), '| name | value |\n|---|---|\n| alphabet | 1 |')
  assert.strictEqual(cellChange(table(d), 1, 0, 'alpha'), null)
})

test('cellChange on empty, padded and missing cells', () => {
  const t = (d: Text, r: number, c: number, s: string) => apply(d, cellChange(table(d), r, c, s))
  assert.strictEqual(t(doc('| a | b |', '|---|---|', '|   |   |'), 1, 1, 'x'), '| a | b |\n|---|---|\n|   | x  |') // the padding stays: a minimal insert
  assert.strictEqual(t(doc('| a | b |', '|---|---|', '||   |'), 1, 0, 'x'), '| a | b |\n|---|---|\n| x |   |')
  assert.strictEqual(t(doc('| a | b |', '|---|---|', '| 1 |'), 1, 1, 'x'), '| a | b |\n|---|---|\n| 1 | x |')
  assert.strictEqual(t(doc('| a | b | c |', '|---|---|---|', '| 1 |'), 1, 2, 'x'), '| a | b | c |\n|---|---|---|\n| 1 |   | x |')
  assert.strictEqual(t(doc('| a | b |', '|---|---|', '| 1'), 1, 1, 'x'), '| a | b |\n|---|---|\n| 1 | x |')
  assert.strictEqual(cellChange(table(doc('| a |', '|---|', '|   |')), 1, 0, ''), null)
})

test('insert and delete columns', () => {
  const d = doc('| a | b |', '|---|---|', '| 1 | 2 |')
  assert.strictEqual(apply(d, insertColChanges(table(d), 1)), '| a | Column 3 | b |\n|---| --- |---|\n| 1 |  | 2 |')
  assert.strictEqual(apply(d, insertColChanges(table(d), 2)), '| a | b | Column 3 |\n|---|---| --- |\n| 1 | 2 |  |')
  assert.strictEqual(apply(d, deleteColsChanges(table(d), [0])), '| b |\n|---|\n| 2 |')
  assert.strictEqual(apply(d, deleteColsChanges(table(d), [1])), '| a |\n|---|\n| 1 |')
  const bare = doc('a | b', '--|--', '1 | 2')
  assert.strictEqual(apply(bare, deleteColsChanges(table(bare), [0])), ' b\n--\n 2')
})

test('rows: insert, delete (the header is replaced by the next row), swap columns, align', () => {
  const d = doc('| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |')
  assert.strictEqual(apply(d, insertRowChange(table(d), 2)), '| a | b |\n|---|---|\n| 1 | 2 |\n|   |   |\n| 3 | 4 |')
  assert.strictEqual(apply(d, insertRowChange(table(d), 3)), '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n|   |   |')
  assert.strictEqual(apply(d, deleteRowsChanges(table(d), [1])), '| a | b |\n|---|---|\n| 3 | 4 |')
  assert.strictEqual(apply(d, deleteRowsChanges(table(d), [0])), '| 1 | 2 |\n|---|---|\n| 3 | 4 |')
  assert.strictEqual(apply(d, swapColsChanges(table(d), 0, 1)), '| b | a |\n|---|---|\n| 2 | 1 |\n| 4 | 3 |')
  assert.strictEqual(apply(d, alignChange(table(d), 1, 'c')), '| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |')
})

test('formatTable pads and aligns', () => {
  assert.strictEqual(formatTable([['x', 'long'], ['1', '2']], ['', 'r']), '| x   | long |\n| --- | ---: |\n| 1   |    2 |')
})

test('rawOffset maps a visible offset into the cell markdown', () => {
  assert.strictEqual(rawOffset('**bold** x', 4), 6)
  assert.strictEqual(rawOffset('a \\| b', 3), 4)
  assert.strictEqual(rawOffset('`code`', 2), 3)
})

test('blankBefore: only right after text', () => {
  const d = doc('text', '', 'more', 'x')
  assert.strictEqual(blankBefore(d, d.line(2).from), '\n')
  assert.strictEqual(blankBefore(d, d.line(3).from), '')
  assert.strictEqual(blankBefore(d, 0), '')
  assert.strictEqual(blankBefore(d, d.line(4).from), '\n')
})

test('a <br> in a cell is a line break while editing, and back', () => {
  assert.strictEqual(cellShown('one<br>two<br/>three'), 'one\ntwo\nthree')
  assert.strictEqual(cellStored('one\ntwo'), 'one<br>two')
  assert.strictEqual(cellStored('a | b\r\nc'), 'a \\| b<br>c')
  assert.strictEqual(cellStored(cellShown('x<br>y')), 'x<br>y')
})

test('copied cells are a markdown table, or one cell\'s text', () => {
  assert.strictEqual(copiedCells([['a<br>b']], ['']), 'a\nb')
  assert.strictEqual(copiedCells([['Name', 'Qty'], ['Apples', '3']], ['', 'r']),
    '| Name   | Qty |\n| ------ | --: |\n| Apples |   3 |')
  assert.strictEqual(copiedCells([['x', 'y']], ['', '']), '| x   | y   |\n| --- | --- |')
})
