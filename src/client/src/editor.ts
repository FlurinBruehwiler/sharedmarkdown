import { EditorSelection, EditorState, type ChangeSpec, type Transaction } from '@codemirror/state'
import { EditorView, dropCursor, keymap, placeholder, type Command } from '@codemirror/view'
import { history as undoHistory, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Language, LanguageSupport } from '@codemirror/language'
import { markdownLanguage, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown'
import type { DelimiterType, InlineContext, MarkdownConfig, MarkdownParser } from '@lezer/markdown'
import { livePreview } from './livepreview'
import { blankBefore, insertTable, tableArrow, tableEnter } from './table'
import { slashMenu } from './slash'
import { dropPos, fileDrops, insertImages, pickImages, type ImageContext } from './images'
import { remote, type DocSync } from './sync'
import { docKey, isReadKey } from './ids'

export interface EditorOptions {
  parent: HTMLElement
  area: HTMLElement
  sync: DocSync
  images: ImageContext
  openLink: (href: string) => void
  linkTitle: (key: string) => Promise<string | null>
  onDocChanged: () => void
}

const HighlightDelim: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' }
const Punctuation = /[\p{S}\p{P}]/u
/** `==highlight==` (markdownguide.org extended syntax), parsed like GFM strikethrough. */
const Highlight: MarkdownConfig = {
  defineNodes: ['Highlight', 'HighlightMark'],
  parseInline: [{
    name: 'Highlight',
    parse(cx: InlineContext, next: number, pos: number) {
      if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61 || cx.char(pos - 1) === 61) return -1
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3)
      const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after)
      const pBefore = Punctuation.test(before), pAfter = Punctuation.test(after)
      return cx.addDelimiter(HighlightDelim, pos, pos + 2,
        !sAfter && (!pAfter || sBefore || pBefore),
        !sBefore && (!pBefore || sAfter || pAfter))
    },
    after: 'Emphasis',
  }],
}

// Same language data as markdownLanguage, so its commands keep working (insertNewlineContinueMarkup
// checks markdownLanguage.isActiveAt). Its parser is typed as a plain lezer Parser but is a MarkdownParser.
export const markdown = new Language(markdownLanguage.data, (markdownLanguage.parser as MarkdownParser).configure([Highlight]), [], 'markdown')

export const wrap = (marker: string): Command => view => {
  view.dispatch(view.state.changeByRange(r => {
    const doc = view.state.doc, n = marker.length
    if (doc.sliceString(r.from - n, r.from) === marker && doc.sliceString(r.to, r.to + n) === marker)
      return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) }
    return { changes: [{ from: r.from, insert: marker }, { from: r.to, insert: marker }], range: EditorSelection.range(r.from + n, r.to + n) }
  }))
  return true
}

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })

// CodeMirror puts a blank line before the new item in a list with blank lines between items (and a blank
// line doesn't end a list, so one list further up is enough). Obsidian never does: take that blank line out.
function continueTight(view: Pick<EditorView, 'state' | 'dispatch'>) {
  let tr: Transaction | undefined
  if (!continueMarkup({ state: view.state, dispatch: t => { tr = t } }) || !tr) return false
  const changes: ChangeSpec[] = []
  const cursor = tr.selection?.main.head ?? 0
  let removedBefore = 0
  tr.changes.iterChanges((from, to, fromB, _toB, text) => {
    let insert = text.toString()
    const blank = /^\n[ \t>]*(?=\n)/.exec(insert)
    if (blank) {
      insert = insert.slice(blank[0].length)
      if (fromB < cursor) removedBefore += blank[0].length
    }
    changes.push({ from, to, insert })
  })
  view.dispatch({ changes, selection: { anchor: cursor - removedBefore }, scrollIntoView: true, userEvent: 'input' })
  return true
}

/** Enter like Obsidian: on an empty list item, task or quote line, remove the marker (or un-indent) instead of continuing it. */
export function enter(view: Pick<EditorView, 'state' | 'dispatch'>) {
  const { state } = view
  const sel = state.selection.main
  if (sel.empty) {
    const line = state.doc.lineAt(sel.head)
    const m = /^(\s*)(?:[-*+]|\d+[.)])(?: \[[ xX]\])?\s*$|^(\s*)>\s*$/.exec(line.text)
    if (m && sel.head === line.to) {
      const indent = m[1] || ''
      if (indent) {
        let parentIndent = ''
        for (let n = line.number - 1; n >= 1; n--) {
          const ind = /^(\s*)(?:[-*+]|\d+[.)])\s/.exec(state.doc.line(n).text)?.[1]
          if (ind != null && ind.length < indent.length) { parentIndent = ind; break }
        }
        view.dispatch({ changes: { from: line.from, to: line.from + indent.length, insert: parentIndent } })
      } else view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from } })
      return true
    }
  }
  return continueTight(view)
}

function insertBlock(view: EditorView, from: number, to: number, block: string, caret: number) {
  const lead = blankBefore(view.state.doc, from)
  view.dispatch({ changes: { from, to, insert: lead + block }, selection: { anchor: from + lead.length + caret }, userEvent: 'input' })
}

/** Backspace right after a list marker removes it in one go (a task loses its box first), like Obsidian. */
export function backspace(view: Pick<EditorView, 'state' | 'dispatch'>) {
  const sel = view.state.selection.main
  if (sel.empty) {
    const line = view.state.doc.lineAt(sel.head)
    const before = line.text.slice(0, sel.head - line.from)
    const keep = (/^(\s*(?:[-*+]|\d+[.)]) )\[[ xX]\] $/.exec(before) ?? /^(\s*)(?:[-*+]|\d+[.)]) $/.exec(before))?.[1]
    if (keep != null) {
      view.dispatch({ changes: { from: line.from + keep.length, to: sel.head }, selection: { anchor: line.from + keep.length }, userEvent: 'delete.backward' })
      return true
    }
  }
  return deleteMarkupBackward(view)
}

export function insertInline(view: Pick<EditorView, 'state' | 'dispatch'>, from: number, to: number, text: string, caret: number) {
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + caret }, userEvent: 'input' })
}

export function insertTask(view: Pick<EditorView, 'state' | 'dispatch'>, from: number, to: number) {
  const line = view.state.doc.lineAt(from)
  const insert = (line.text.slice(0, from - line.from).trim() ? '\n' : '') + '- [ ] '
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input' })
}

function pasteLink(view: EditorView, url: string, linkTitle: EditorOptions['linkTitle']) {
  const sel = view.state.selection.main
  if (!sel.empty) {
    view.dispatch(view.state.replaceSelection(`[${view.state.sliceDoc(sel.from, sel.to)}](${url})`))
    return
  }
  const insert = (title: string | null) => view.dispatch(view.state.replaceSelection(title ? `[${title.replace(/[\[\]]/g, '')}](${url})` : url))
  let key: string | null = null
  try { const u = new URL(url); if (u.host === location.host) key = docKey(u.pathname) } catch {}
  if (!key) return insert(null)
  linkTitle(key).then(insert, () => insert(null))
}

/**
 * Read-only links. readOnly/editable stop typing but not edits made by code (task checkboxes, table
 * tools, menus), so every change that doesn't come from the server is dropped too. The server refuses them anyway.
 */
const readOnly = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorState.transactionFilter.of(tr => tr.docChanged && !tr.annotation(remote) ? [] : tr),
]

export function createEditor(opts: EditorOptions) {
  const { images } = opts
  const slashItems = slashMenu([
    {
      label: 'Table', hint: '3 columns, a header and 2 rows', icon: '▦', keywords: 'grid columns rows',
      run: (view, from, to) => insertTable(view, from, to, [['Column 1', 'Column 2', 'Column 3'], ['', '', ''], ['', '', '']]),
    },
    {
      label: 'Checkbox', hint: 'A task you can tick off', icon: '☐', keywords: 'task todo check list',
      run: (view, from, to) => insertTask(view, from, to),
    },
    {
      label: 'Code block', hint: 'Monospace, keeps spacing', icon: '{ }', keywords: 'code fence snippet',
      run: (view, from, to) => insertBlock(view, from, to, '```\n\n```', 4),
    },
    {
      label: 'Divider', hint: 'A horizontal line', icon: '—', keywords: 'rule hr line separator',
      run: (view, from, to) => insertBlock(view, from, to, '---\n', 4),
    },
    {
      label: 'Link', hint: '[text](url)', icon: '↗', keywords: 'url href web', inline: true,
      run: (view, from, to) => insertInline(view, from, to, '[]()', 1),
    },
    {
      label: 'Image', hint: '![alt](url)', icon: '▣', keywords: 'picture url embed', inline: true,
      run: (view, from, to) => insertInline(view, from, to, '![]()', 4),
    },
    {
      label: 'Upload image', hint: 'From this device', icon: '⇪', keywords: 'picture photo upload file', inline: true,
      run: (view, from, to) => {
        view.dispatch({ changes: { from, to }, selection: { anchor: from } })
        pickImages(images, view)
      },
    },
  ])

  const extensions = [
    slashItems,
    opts.sync.extension(),
    new LanguageSupport(markdown),
    livePreview(opts.openLink),
    fileDrops(images),
    dropCursor(), // for text dragged within the editor; file drags draw their own caret
    undoHistory(),
    keymap.of([
      { key: 'Enter', run: v => tableEnter(v) || enter(v) },
      { key: 'ArrowDown', run: tableArrow(true) },
      { key: 'ArrowUp', run: tableArrow(false) },
      { key: 'Backspace', run: backspace },
      { key: 'Mod-b', run: wrap('**') },
      { key: 'Mod-i', run: wrap('*') },
      { key: 'Mod-Shift-h', run: wrap('==') },
      ...defaultKeymap, ...historyKeymap, indentWithTab,
    ]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    EditorView.domEventHandlers({
      paste(e, view) {
        if (view.state.readOnly) return false
        const data = e.clipboardData
        if (!data) return false
        if (data.files.length && insertImages(images, view, data.files)) return true
        const text = data.getData('text/plain').trim()
        if (/^https?:\/\/\S+$/.test(text)) { pasteLink(view, text, opts.linkTitle); return true }
        return false
      },
    }),
    EditorView.updateListener.of(u => { if (u.docChanged) opts.onDocChanged() }),
  ]

  /** A fresh state per document, so undo history doesn't leak between documents. */
  const stateFor = (key: string) => EditorState.create({
    extensions: [extensions, isReadKey(key) ? [readOnly, placeholder('This document is empty.')] : placeholder('Start writing…')],
  })

  const view = new EditorView({ parent: opts.parent, state: stateFor('') })

  opts.area.addEventListener('mousedown', e => {
    if (e.button !== 0 || !(e.target instanceof Element)) return
    if (e.target.closest('.cm-content, header, button, a, input, .cm-tbl, .cm-img, .sm-menu')) return
    const pos = dropPos(view, e)
    if (pos == null) return
    e.preventDefault()
    const anchor = e.shiftKey ? view.state.selection.main.anchor : pos
    view.dispatch({ selection: { anchor, head: pos }, scrollIntoView: true, userEvent: 'select.pointer' })
    view.focus()
  })
  // The transaction filter keeps task checkboxes from changing the text, but the browser would still tick the box.
  opts.parent.addEventListener('click', e => {
    if (view.state.readOnly && e.target instanceof HTMLInputElement && e.target.type === 'checkbox') e.preventDefault()
  }, true)

  return { view, reset: (key: string) => view.setState(stateFor(key)) }
}
