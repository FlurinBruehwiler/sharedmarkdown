// Obsidian-style live preview for CodeMirror: the text stays plain markdown, styling comes from
// decorations, and syntax markers are hidden unless the cursor is at them. Like Obsidian:
// headings, quotes and rules reveal their syntax for the whole line; inline elements (emphasis,
// code, links, images) and list/task markers only while the cursor or selection touches them.
import { Decoration, ViewPlugin, WidgetType, EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt }
  eq(o) { return o.src === this.src && o.alt === this.alt }
  toDOM() {
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.className = 'cm-img'
    return img
  }
}

class TextWidget extends WidgetType {
  constructor(text, cls) { super(); this.text = text; this.cls = cls }
  eq(o) { return o.text === this.text && o.cls === this.cls }
  toDOM() {
    const s = document.createElement('span')
    s.className = this.cls
    s.textContent = this.text
    return s
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked }
  eq(o) { return o.checked === this.checked }
  toDOM(view) {
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
  ignoreEvent() { return false }
}

class HrWidget extends WidgetType {
  eq() { return true }
  toDOM() { return document.createElement('hr') }
}

const hidden = Decoration.replace({})
const line = cls => Decoration.line({ class: cls })
const mark = cls => Decoration.mark({ class: cls })

function build(view) {
  const { state } = view
  const doc = state.doc
  const decos = []
  const activeLines = new Set()
  if (view.hasFocus)
    for (const r of state.selection.ranges)
      for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) activeLines.add(l)
  const active = (from, to = from) => {
    for (let l = doc.lineAt(from).number, end = doc.lineAt(to).number; l <= end; l++) if (activeLines.has(l)) return true
    return false
  }
  // Selection touching [from, to], boundaries included (cursor right after `*foo*` still reveals it).
  const touches = (from, to) => view.hasFocus && state.selection.ranges.some(r => r.from <= to && r.to >= from)
  const lines = (from, to, cls) => {
    for (let l = doc.lineAt(from).number, end = doc.lineAt(to).number; l <= end; l++) decos.push(line(cls).range(doc.line(l).from))
  }
  // Hide a marker plus the single space that follows it (e.g. "## ", "> ").
  const hideWithSpace = (from, to) => decos.push(hidden.range(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to))

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
          case 'InlineCode': decos.push(mark('cm-code').range(n.from, n.to)); break
          case 'EmphasisMark':
          case 'StrikethroughMark': {
            const p = n.node.parent
            decos.push((touches(p.from, p.to) ? mark('cm-meta') : hidden).range(n.from, n.to))
            break
          }
          case 'CodeMark': {
            const p = n.node.parent
            if (p?.name === 'InlineCode') decos.push((touches(p.from, p.to) ? mark('cm-meta') : hidden).range(n.from, n.to))
            break
          }
          case 'FencedCode':
          case 'CodeBlock': {
            lines(n.from, n.to, 'cm-codeblock')
            decos.push(line('cm-codeblock cm-fence').range(doc.lineAt(n.from).from))
            if (name === 'FencedCode' && doc.lineAt(n.to).number > doc.lineAt(n.from).number)
              decos.push(line('cm-codeblock cm-fence').range(doc.lineAt(n.to).from))
            return false
          }
          case 'Blockquote': lines(n.from, n.to, 'cm-quote'); break
          case 'QuoteMark': if (!active(n.from)) hideWithSpace(n.from, n.to); break
          case 'Table': lines(n.from, n.to, 'cm-table'); return false
          case 'HorizontalRule':
            if (!active(n.from)) decos.push(Decoration.replace({ widget: new HrWidget() }).range(n.from, n.to))
            break
          case 'ListMark': {
            const item = n.node.parent
            const task = item?.getChild('Task')
            const marker = task?.getChild('TaskMarker')
            if (marker) {
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
            const widget = new ImageWidget(src, alt)
            if (touches(n.from, n.to)) {
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

export function livePreview(openLink) {
  return [
    ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = build(view) }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
          this.decorations = build(u.view)
      }
    }, { decorations: v => v.decorations }),
    EditorView.domEventHandlers({
      mousedown(e) {
        const a = e.target.closest?.('.cm-live[data-href]')
        if (!a || e.button !== 0) return false
        e.preventDefault()
        openLink(a.dataset.href)
        return true
      },
    }),
  ]
}
