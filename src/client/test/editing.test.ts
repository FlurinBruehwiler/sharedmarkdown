// Markdown editing keys, checked against what Obsidian does. "|" marks the cursor (or a selection between two "|").
import { test } from 'node:test'
import assert from 'node:assert'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { indentLess, indentMore, insertNewlineAndIndent } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { backspace, enter, insertInline, insertTask, markdown, wrap } from '../src/editor'

type View = { state: EditorState, dispatch: (...specs: (Transaction | TransactionSpec)[]) => void }
type Cmd = (view: never) => boolean

function run(before: string, cmd: Cmd) {
  const marks = [...before.matchAll(/\|/g)].map((m, i) => m.index - i)
  if (!marks.length) throw new Error('no cursor in ' + JSON.stringify(before))
  let state = EditorState.create({
    doc: before.replaceAll('|', ''),
    selection: EditorSelection.single(marks[0], marks[1] ?? marks[0]),
    extensions: markdown,
  })
  ensureSyntaxTree(state, state.doc.length, 5000)
  const view: View = {
    get state() { return state },
    dispatch: (...specs) => { state = (specs[0] instanceof Transaction ? specs[0] : state.update(...specs as TransactionSpec[])).state },
  }
  cmd(view as never)
  const { from, to } = state.selection.main
  const doc = state.doc.toString()
  return from === to ? doc.slice(0, from) + '|' + doc.slice(from) : doc.slice(0, from) + '|' + doc.slice(from, to) + '|' + doc.slice(to)
}

// As in the keymap: where enter() doesn't apply, CodeMirror's default Enter runs.
const enterKey = (v: View) => enter(v as never) || insertNewlineAndIndent(v as never)
const inline = (text: string, caret: number) => (v: View) => (insertInline(v as never, v.state.selection.main.from, v.state.selection.main.to, text, caret), true)
const task = (v: View) => (insertTask(v as never, v.state.selection.main.from, v.state.selection.main.to), true)

const cases: [string, Cmd, string, string][] = [
  ['Enter continues a bullet list', enterKey, '- some text|', '- some text\n- |'],
  ['Enter continues a list that has blank lines between items, without adding one', enterKey, '- a\n\n- b\n\n- some text|', '- a\n\n- b\n\n- some text\n- |'],
  ['Enter continues a list after an earlier list higher up', enterKey, '- x\n\nParagraph\n\n- some text|', '- x\n\nParagraph\n\n- some text\n- |'],
  ['Enter keeps the bullet character', enterKey, '* a|', '* a\n* |'],
  ['Enter on an empty bullet ends the list', enterKey, '- a\n- |', '- a\n|'],
  ['Enter on an empty nested bullet outdents it', enterKey, '- a\n  - |', '- a\n- |'],
  ['Enter in the middle of an item splits it', enterKey, '- ab|cd', '- ab\n- |cd'],
  ['Enter between items inserts one', enterKey, '- a|\n- b', '- a\n- |\n- b'],
  ['Enter continues a numbered list', enterKey, '1. a|', '1. a\n2. |'],
  ['Enter in a numbered list renumbers the rest', enterKey, '1. a|\n2. b', '1. a\n2. |\n3. b'],
  ['Enter on an empty numbered item ends the list', enterKey, '1. a\n2. |', '1. a\n|'],
  ['Enter continues a task with an unchecked box', enterKey, '- [ ] buy milk|', '- [ ] buy milk\n- [ ] |'],
  ['Enter after a checked task starts an unchecked one', enterKey, '- [x] done|', '- [x] done\n- [ ] |'],
  ['Enter on an empty task ends the list', enterKey, '- [ ] a\n- [ ] |', '- [ ] a\n|'],
  ['Enter continues a quote', enterKey, '> quoted|', '> quoted\n> |'],
  ['Enter on an empty quote line ends the quote', enterKey, '> quoted\n> |', '> quoted\n|'],
  ['Enter after a heading is a plain new line', enterKey, '# Title|', '# Title\n|'],
  ['Enter in a paragraph is a plain new line', enterKey, 'Some text|', 'Some text\n|'],
  ['Enter inside a code block is a plain new line', enterKey, '```\n- code|\n```', '```\n- code\n|\n```'],
  ['Enter on an empty document', enterKey, '|', '\n|'],
  ['Backspace right after a bullet marker removes it', backspace, '- a\n- |', '- a\n|'],
  ['Backspace right after a task marker removes the box first', backspace, '- [ ] |', '- |'],
  ['Backspace after a quote marker removes it', backspace, '> |', '|'],
  ['Backspace before the text of an item removes the bullet', backspace, '- |text', '|text'],
  ['Backspace after a nested empty bullet keeps the indentation', backspace, '- a\n  - |', '- a\n  |'],
  ['Backspace after a numbered marker removes it', backspace, '1. |', '|'],
  ['Tab indents a list item', indentMore, '- a\n- b|', '- a\n  - b|'],
  ['Shift-Tab outdents a list item', indentLess, '- a\n  - b|', '- a\n- b|'],
  ['Mod-B wraps the selection in bold', wrap('**'), 'a |word| b', 'a **|word|** b'],
  ['Mod-B again removes the bold', wrap('**'), 'a **|word|** b', 'a |word| b'],
  ['Mod-B without a selection leaves the cursor between the markers', wrap('**'), 'a |', 'a **|**'],
  ['Mod-I wraps the selection in italics', wrap('*'), '|word|', '*|word|*'],
  ['The checkbox command on an empty line', task, '|', '- [ ] |'],
  ['The checkbox command after text starts a new line', task, 'Groceries|', 'Groceries\n- [ ] |'],
  ['The link command puts the cursor in the link text', inline('[]()', 1), 'See |', 'See [|]()'],
  ['The image command puts the cursor in the URL', inline('![]()', 4), '|', '![](|)'],
]

for (const [name, cmd, before, after] of cases)
  test(name, () => assert.strictEqual(run(before, cmd), after))
