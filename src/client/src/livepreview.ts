// Obsidian-style live preview for CodeMirror: the text stays plain markdown, styling comes from
// decorations, and syntax markers are hidden unless the cursor is at them. Like Obsidian:
// headings, quotes and rules reveal their syntax for the whole line; inline elements (emphasis,
// code, links, images) and list/task markers only while the cursor or selection touches them.
import { Decoration, ViewPlugin, WidgetType, EditorView, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { EditorSelection, type EditorState, type Extension, type Range } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { tables } from './table'
import { localImages, uploadStarted } from './images'

/** An `upload:` placeholder older than this (images.ts) is presumed dead. */
const uploadTimeout = 2 * 60 * 1000

class ImageWidget extends WidgetType {
  src: string
  alt: string
  selected: boolean
  constructor(src: string, alt: string, selected = false) { super(); this.src = src; this.alt = alt; this.selected = selected }
  override eq(o: ImageWidget) { return o.src === this.src && o.alt === this.alt && o.selected === this.selected }
  // Let the editor see clicks on the image, so they select it (see the mousedown handler below).
  override ignoreEvent(e: Event) { return e.type !== 'mousedown' }
  toDOM() {
    const local = localImages.get(this.src)
    if (!local && this.src.startsWith('upload:')) {
      // Someone else's image that is still uploading (or whose tab closed mid-upload).
      const started = uploadStarted(this.src) ?? Date.now()
      const box = document.createElement('span')
      box.className = this.selected ? 'cm-img-pending cm-img-selected' : 'cm-img-pending'
      box.textContent = Date.now() - started > uploadTimeout ? "Image upload didn't finish" : 'Uploading image…'
      return box
    }
    const img = document.createElement('img')
    img.src = local ?? this.src
    img.alt = this.alt
    img.className = this.selected ? 'cm-img cm-img-selected' : 'cm-img'
    return img
  }
}

class TextWidget extends WidgetType {
  text: string
  cls: string
  constructor(text: string, cls: string) { super(); this.text = text; this.cls = cls }
  override eq(o: TextWidget) { return o.text === this.text && o.cls === this.cls }
  toDOM() {
    const s = document.createElement('span')
    s.className = this.cls
    s.textContent = this.text
    return s
  }
}

class CopyWidget extends WidgetType {
  override eq() { return true }
  toDOM(view: EditorView) {
    const b = document.createElement('button')
    b.className = 'cm-cb-copy'
    b.type = 'button'
    b.tabIndex = -1
    b.textContent = 'Copy'
    b.onmousedown = e => {
      e.preventDefault()
      e.stopPropagation()
      // The code block this button belongs to, read from the source at click time.
      let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(view.posAtDOM(b), -1)
      while (node && node.name !== 'FencedCode') node = node.parent
      const text = node?.getChild('CodeText')
      if (!text) return
      navigator.clipboard?.writeText(view.state.doc.sliceString(text.from, text.to)).then(() => {
        b.textContent = 'Copied'
        setTimeout(() => { b.textContent = 'Copy' }, 1200)
      }, () => {})
    }
    return b
  }
  override ignoreEvent() { return true }
}

class CheckboxWidget extends WidgetType {
  checked: boolean
  constructor(checked: boolean) { super(); this.checked = checked }
  override eq(o: CheckboxWidget) { return o.checked === this.checked }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-task'
    box.onmousedown = e => {
      e.preventDefault()
      const pos = view.posAtDOM(box)
      const line = view.state.doc.lineAt(pos)
      const m = /\[( |x|X)\]/.exec(line.text.slice(pos - line.from))
      if (!m) return
      const at = pos + m.index + 1
      view.dispatch({ changes: { from: at, to: at + 1, insert: m[1] === ' ' ? 'x' : ' ' } })
    }
    return box
  }
  override ignoreEvent() { return false }
}

const hidden = Decoration.replace({})
const line = (cls: string) => Decoration.line({ class: cls })
const mark = (cls: string) => Decoration.mark({ class: cls })

function build(view: EditorView): DecorationSet {
  const { state } = view
  const doc = state.doc
  const decos: Range<Decoration>[] = []
  const activeLines = new Set<number>()
  if (view.hasFocus)
    for (const r of state.selection.ranges)
      for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) activeLines.add(l)
  const active = (from: number, to = from) => {
    for (let l = doc.lineAt(from).number, end = doc.lineAt(to).number; l <= end; l++) if (activeLines.has(l)) return true
    return false
  }
  // Selection touching [from, to], boundaries included (cursor right after `*foo*` still reveals it).
  const touches = (from: number, to: number) => view.hasFocus && state.selection.ranges.some(r => r.from <= to && r.to >= from)
  const lines = (from: number, to: number, cls: string) => {
    for (let l = doc.lineAt(from).number, end = doc.lineAt(to).number; l <= end; l++) decos.push(line(cls).range(doc.line(l).from))
  }
  // Hide a marker plus the single space that follows it (e.g. "## ", "> ").
  const hideWithSpace = (from: number, to: number) => decos.push(hidden.range(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to))

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(n) {
        const name = n.name
        if (name.startsWith('ATXHeading')) {
          decos.push(line('cm-h' + name.slice(10)).range(doc.lineAt(n.from).from))
        } else if (name.startsWith('SetextHeading')) {
          lines(n.from, n.to, 'cm-h' + name.slice(13))
        } else switch (name) {
          case 'HeaderMark':
            if (n.node.parent?.name.startsWith('ATXHeading') && !active(n.from)) hideWithSpace(n.from, n.to)
            break
          case 'Emphasis': decos.push(mark('cm-em').range(n.from, n.to)); break
          case 'StrongEmphasis': decos.push(mark('cm-strong').range(n.from, n.to)); break
          case 'Strikethrough': decos.push(mark('cm-strike').range(n.from, n.to)); break
          case 'Highlight': decos.push(mark('cm-mark').range(n.from, n.to)); break
          case 'InlineCode': decos.push(mark('cm-code').range(n.from, n.to)); break
          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'HighlightMark': {
            const p = n.node.parent
            if (p) decos.push((touches(p.from, p.to) ? mark('cm-meta') : hidden).range(n.from, n.to))
            break
          }
          case 'CodeMark': {
            const p = n.node.parent
            if (p?.name === 'InlineCode') decos.push((touches(p.from, p.to) ? mark('cm-meta') : hidden).range(n.from, n.to))
            break
          }
          case 'FencedCode': {
            // One rounded box. Outside the block the fences lose their backticks (the opening one
            // keeps a small language label), inside it they show raw; each line keeps its height.
            const first = doc.lineAt(n.from), last = doc.lineAt(n.to)
            const marks = n.node.getChildren('CodeMark')
            const closed = marks.length > 1 && last.number > first.number && marks[marks.length - 1].from >= last.from
            const editing = active(n.from, n.to)
            for (let l = first.number; l <= last.number; l++) {
              let cls = 'cm-codeblock'
              if (l === first.number) cls += ' cm-cb-first cm-fence'
              if (l === last.number) cls += ' cm-cb-last'
              if (l === last.number && closed) cls += ' cm-fence'
              decos.push(line(cls).range(doc.line(l).from))
            }
            const info = n.node.getChild('CodeInfo')
            if (editing) {
              if (info) decos.push(mark('cm-meta').range(info.from, info.to))
            } else {
              const open = marks[0]
              if (open) decos.push(hidden.range(open.from, open.to))
              if (info) {
                const lang = doc.sliceString(info.from, info.to).split(/\s/)[0]
                decos.push(mark('cm-cb-lang').range(info.from, info.from + lang.length))
                if (info.to > info.from + lang.length) decos.push(hidden.range(info.from + lang.length, info.to))
              }
              if (marks[0]) decos.push(Decoration.widget({ widget: new CopyWidget(), side: 1 }).range(first.to))
              if (closed) decos.push(hidden.range(marks[marks.length - 1].from, last.to))
            }
            return false
          }
          case 'CodeBlock': {
            const first = doc.lineAt(n.from).number, last = doc.lineAt(n.to).number
            for (let l = first; l <= last; l++)
              decos.push(line('cm-codeblock' + (l === first ? ' cm-cb-first' : '') + (l === last ? ' cm-cb-last' : '')).range(doc.line(l).from))
            return false
          }
          case 'Blockquote': lines(n.from, n.to, 'cm-quote'); break
          case 'QuoteMark': if (!active(n.from)) hideWithSpace(n.from, n.to); break
          case 'Table':
            // Source view of a table (the rendered one is a block widget from table.ts).
            lines(n.from, n.to, 'cm-table')
            break
          case 'TableHeader':
          case 'TableRow':
            // Raw while editing: dim the pipes, bold the header, no hidden markers (keeps columns aligned).
            if (name === 'TableHeader') decos.push(mark('cm-strong').range(n.from, n.to))
            for (const d of n.node.getChildren('TableDelimiter')) decos.push(mark('cm-meta').range(d.from, d.to))
            return false
          case 'TableDelimiter': decos.push(mark('cm-meta').range(n.from, n.to)); break
          case 'HorizontalRule':
            // Keep the text (just invisible) and draw the rule in the same line, so the height never changes.
            if (!active(n.from)) {
              decos.push(line('cm-hr').range(doc.lineAt(n.from).from))
              decos.push(mark('cm-hr-text').range(n.from, n.to))
            }
            break
          case 'ListMark': {
            const item = n.node.parent
            const task = item?.getChild('Task')
            const marker = task?.getChild('TaskMarker')
            if (task && marker) {
              const checked = /x/i.test(doc.sliceString(marker.from, marker.to))
              if (checked) decos.push(mark('cm-done').range(marker.to, task.to))
              if (!touches(n.from, marker.to)) decos.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(n.from, marker.to))
            } else if (/[-*+]/.test(doc.sliceString(n.from, n.to)) && !touches(n.from, n.to)) {
              decos.push(Decoration.replace({ widget: new TextWidget('•', 'cm-bullet') }).range(n.from, n.to))
            } else decos.push(mark('cm-listmark').range(n.from, n.to))
            break
          }
          case 'Link': {
            const marks = n.node.getChildren('LinkMark')
            const url = n.node.getChild('URL')
            if (marks.length < 2) break
            const textFrom = marks[0].to, textTo = marks[1].from
            const href = url ? doc.sliceString(url.from, url.to) : ''
            if (touches(n.from, n.to)) {
              decos.push(mark('cm-meta').range(n.from, textFrom))
              if (textTo > textFrom) decos.push(mark('cm-link').range(textFrom, textTo))
              decos.push(mark('cm-meta').range(textTo, n.to))
            } else if (textTo > textFrom) {
              decos.push(hidden.range(n.from, textFrom))
              decos.push(Decoration.mark({ class: 'cm-link cm-live', attributes: { 'data-href': href } }).range(textFrom, textTo))
              decos.push(hidden.range(textTo, n.to))
            }
            return false
          }
          case 'Autolink': {
            const url = n.node.getChild('URL')
            if (!url) break
            const href = doc.sliceString(url.from, url.to)
            const live = !touches(n.from, n.to)
            if (live) decos.push(hidden.range(n.from, url.from))
            decos.push(Decoration.mark({ class: live ? 'cm-link cm-live' : 'cm-link', attributes: { 'data-href': href } }).range(url.from, url.to))
            if (live) decos.push(hidden.range(url.to, n.to))
            return false
          }
          case 'URL': {
            const href = doc.sliceString(n.from, n.to)
            decos.push(Decoration.mark({ class: touches(n.from, n.to) ? 'cm-link' : 'cm-link cm-live', attributes: { 'data-href': href } }).range(n.from, n.to))
            break
          }
          case 'Image': {
            const url = n.node.getChild('URL')
            const marks = n.node.getChildren('LinkMark')
            if (!url) break
            const src = doc.sliceString(url.from, url.to)
            const alt = marks.length > 1 ? doc.sliceString(marks[0].to, marks[1].from) : ''
            // Selected as a whole (a click on it): stays an image, outlined, so Backspace/Delete removes it.
            const selected = view.hasFocus && state.selection.ranges.some(r => r.from === n.from && r.to === n.to)
            const widget = new ImageWidget(src, alt, selected)
            if (!selected && touches(n.from, n.to)) {
              decos.push(mark('cm-meta').range(n.from, n.to))
              decos.push(Decoration.widget({ widget, side: 1 }).range(n.to))
            } else decos.push(Decoration.replace({ widget }).range(n.from, n.to))
            return false
          }
        }
      },
    })
  }
  return Decoration.set(decos, true)
}

function imageAt(state: EditorState, pos: number) {
  for (const side of [1, -1] as const)
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent)
      if (n.name === 'Image') return n
  return null
}

/** Backspace/Delete on a selected image removes it, and its line if it stood alone there. */
export function deleteSelectedImage(view: EditorView) {
  const { state } = view
  const sel = state.selection.main
  const img = sel.empty ? null : imageAt(state, sel.from)
  if (!img || img.from !== sel.from || img.to !== sel.to) return false
  const line = state.doc.lineAt(img.from)
  const alone = line.text.trim() === state.doc.sliceString(img.from, img.to) && line.to === state.doc.lineAt(img.to).to
  const from = alone ? (line.number > 1 ? line.from - 1 : line.from) : img.from
  const to = alone && line.number === 1 && line.to < state.doc.length ? line.to + 1 : alone ? line.to : img.to
  view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: 'delete.selection', scrollIntoView: true })
  return true
}

export function livePreview(openLink: (href: string) => void): Extension {
  return [
    tables(openLink),
    ViewPlugin.fromClass(class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = build(view) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
          this.decorations = build(u.view)
      }
    }, { decorations: v => v.decorations }),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const pic = e.target instanceof Element ? e.target.closest('.cm-img, .cm-img-pending') : null
        if (pic && e.button === 0) {
          const img = imageAt(view.state, view.posAtDOM(pic))
          if (img) {
            e.preventDefault()
            view.dispatch({ selection: EditorSelection.single(img.from, img.to) })
            view.focus()
            return true
          }
        }
        const a = e.target instanceof Element ? e.target.closest<HTMLElement>('.cm-live[data-href]') : null
        if (!a || e.button !== 0) return false
        e.preventDefault()
        openLink(a.dataset.href!) // the selector requires data-href
        return true
      },
    }),
  ]
}
