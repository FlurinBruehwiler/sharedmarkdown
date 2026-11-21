// titleOf (sidebar.ts) mirrors DocStore.TitleOf on the server.
import { test } from 'node:test'
import assert from 'node:assert'
import { titleOf } from '../src/sidebar'

const cases: [string, string][] = [
  ['# Hello world\nbody', 'Hello world'],
  ['\n\n  \nSecond line', 'Second line'],
  ['## **Bold** and `code`', 'Bold and code'],
  ['![img](/b/x)\n[Link text](https://example.com) more', 'Link text more'],
  ['- [x] done task', 'done task'],
  ['> quoted ==mark==', 'quoted mark'],
  ['1. numbered', 'numbered'],
  ['\\# not a heading', 'not a heading'], // as on the server: unescaped first, then the marker goes
  ['~~gone~~ __under__', 'gone under'],
  ['', ''],
  ['x'.repeat(100), 'x'.repeat(80)],
]

test('titleOf', () => {
  for (const [md, title] of cases) assert.strictEqual(titleOf(md), title, JSON.stringify(md))
})
