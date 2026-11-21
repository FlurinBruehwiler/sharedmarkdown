// Text diff and three-way merge (text.ts).
import { test } from 'node:test'
import assert from 'node:assert'
import { applyEdits, diff, diffText, merge3 } from '../src/text'

let seed = 7
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
const words = ['alpha ', 'beta ', 'gamma\n', 'delta ', '| a | b |\n', 'x', '\n', '# Title\n']
const randomText = (n: number) => Array.from({ length: n }, () => words[rnd(words.length)]).join('')
/** A random edit of `s`: a few insertions, deletions and replacements. */
function mutate(s: string) {
  for (let i = rnd(4) + 1; i > 0; i--) {
    const p = rnd(s.length + 1), d = rnd(Math.min(12, s.length - p) + 1)
    s = s.slice(0, p) + (rnd(3) ? randomText(rnd(3)) : '') + s.slice(p + d)
  }
  return s
}

test('diff: common prefix and suffix', () => {
  assert.deepStrictEqual(diff('hello world', 'hello brave world'), { p: 6, d: 0, i: 'brave ' })
  assert.deepStrictEqual(diff('abc', 'abc'), { p: 3, d: 0, i: '' })
})

test('diffText turns a into b with sorted, non-overlapping edits', () => {
  for (let round = 0; round < 500; round++) {
    const a = randomText(rnd(40)), b = rnd(4) ? mutate(a) : randomText(rnd(40))
    const edits = diffText(a, b)
    assert.strictEqual(applyEdits(a, edits), b, 'round ' + round)
    for (let i = 1; i < edits.length; i++) assert.ok(edits[i].from >= edits[i - 1].to)
  }
  assert.deepStrictEqual(diffText('same', 'same'), [])
})

test('diffText keeps separate changes separate', () => {
  const a = 'one\ntwo\nthree\nfour\n', b = 'ONE\ntwo\nthree\nfour!\n'
  const edits = diffText(a, b)
  assert.ok(edits.length >= 2)
  assert.ok(edits.every(e => e.to - e.from <= 4))
})

test('diffText is fast on large, very different texts', () => {
  const a = randomText(8000), b = randomText(8000)
  const t = performance.now()
  assert.strictEqual(applyEdits(a, diffText(a, b)), b)
  assert.ok(performance.now() - t < 2000)
})

const merged = (base: string, ours: string, theirs: string) => applyEdits(theirs, merge3(base, ours, theirs))

test('merge3: both sides\' separate edits survive', () => {
  assert.strictEqual(merged('hello world', 'hello brave world', 'hello world!'), 'hello brave world!')
  const base = 'line one\nline two\nline three\n'
  assert.strictEqual(
    merged(base, 'line one (mine)\nline two\nline three\n', 'line one\nline two\nline three (theirs)\nline four\n'),
    'line one (mine)\nline two\nline three (theirs)\nline four\n')
  // Others typed inside a span this device changed elsewhere in: the old prefix/suffix merge deleted their text.
  assert.strictEqual(merged('a b c d e', 'A b c d E', 'a b XX c d e'), 'A b XX c d E')
})

test('merge3: our deletions apply, unless someone else changed that text', () => {
  assert.strictEqual(merged('keep drop keep', 'keep keep', 'keep drop keep!'), 'keep keep!')
  assert.strictEqual(merged('keep drop keep', 'keep keep', 'keep drXop keep'), 'keep drXop keep')
})

test('merge3: conflicting edits keep both, theirs first', () => {
  assert.strictEqual(merged('abc', 'aXc', 'aYc'), 'aYXc')
  assert.strictEqual(merged('ab', 'aXb', 'aYb'), 'aYXb') // both inserted at the same point
  assert.strictEqual(merged('', 'mine', 'theirs'), 'theirsmine')
})

test('merge3: one side unchanged gives the other side', () => {
  for (let round = 0; round < 300; round++) {
    const base = randomText(rnd(30)), changed = mutate(base)
    assert.strictEqual(merged(base, changed, base), changed, 'ours only, round ' + round)
    assert.strictEqual(merged(base, base, changed), changed, 'theirs only, round ' + round)
    assert.strictEqual(merged(base, changed, changed).length >= changed.length, true)
  }
})

test('merge3: everything either side inserted is in the result', () => {
  for (let round = 0; round < 300; round++) {
    const base = randomText(rnd(30))
    const ours = base + ' OURS' + round, theirs = 'THEIRS' + round + ' ' + mutate(base)
    const m = merged(base, ours, theirs)
    assert.ok(m.includes('OURS' + round) && m.includes('THEIRS' + round), 'round ' + round)
  }
})
