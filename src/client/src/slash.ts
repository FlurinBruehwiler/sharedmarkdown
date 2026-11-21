// The "/" menu: typing / at the start of an empty line offers things to insert (a table, a code
// block, ...); after a space within text, only the inline ones (a link, an image). Typing filters it,
// arrow keys and Enter pick, Escape or any other edit closes it.
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view'

export interface SlashItem {
  label: string
  hint: string
  icon: string
  /** Extra words that match when filtering. */
  keywords?: string
  /** Can go within a line of text, not only on a line of its own. */
  inline?: boolean
  /** Replaces from..to (the typed "/query") with the inserted content. */
  run: (view: EditorView, from: number, to: number) => void
}

interface Open { from: number, to: number, query: string, inline: boolean, index: number }

export function slashMenu(items: SlashItem[]): Extension {
  let plugin: SlashPlugin | null = null

  class SlashPlugin {
    open: Open | null = null
    el: HTMLDivElement | null = null
    view: EditorView
    constructor(view: EditorView) { this.view = view; plugin = this }

    update(u: ViewUpdate) {
      if (!u.docChanged && !u.selectionSet && !u.focusChanged) return
      const next = this.detect(u)
      if (!next) return this.close()
      const sameQuery = this.open?.query === next.query
      this.open = { ...next, index: sameQuery ? this.open!.index : 0 } // open is set: same query
      this.render()
    }

    /** "/query" typed on an otherwise empty line, or after a space within text, with the caret right after it. */
    detect(u: ViewUpdate): Omit<Open, 'index'> | null {
      const { state } = u.view
      // Losing focus closes the menu. (Opening needs local typing, see below, so remote edits never open it.)
      if (u.focusChanged && !u.view.hasFocus) return null
      const sel = state.selection.main
      if (!sel.empty) return null
      const line = state.doc.lineAt(sel.head)
      const before = line.text.slice(0, sel.head - line.from)
      const own = sel.head === line.to ? /^\/([\w ]{0,20})$/.exec(line.text) : null
      const within = own ? null : /(?:^|\s)\/(\w{0,20})$/.exec(before)
      const m = own ?? within
      if (!m) return null
      // Only open on typing, then keep it open while the query is edited.
      const typed = u.transactions.some(tr => tr.isUserEvent('input.type') || tr.isUserEvent('delete'))
      if (!this.open && !typed) return null
      const from = own ? line.from : sel.head - m[1].length - 1
      return { from, to: sel.head, query: m[1].toLowerCase().trim(), inline: !own }
    }

    matches() {
      const q = this.open?.query ?? ''
      return items.filter(i => (i.inline || !this.open?.inline) && (i.label + ' ' + (i.keywords ?? '')).toLowerCase().includes(q))
    }

    render() {
      const open = this.open!
      const list = this.matches()
      if (!list.length) return this.close()
      open.index = Math.min(open.index, list.length - 1)
      if (!this.el) {
        this.el = document.createElement('div')
        this.el.className = 'sm-menu sm-slash'
        this.el.setAttribute('role', 'listbox')
        document.body.append(this.el)
      }
      this.el.replaceChildren(...list.map((item, i) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.setAttribute('role', 'option')
        b.setAttribute('aria-selected', String(i === open.index))
        b.classList.toggle('active', i === open.index)
        const icon = document.createElement('span')
        icon.className = 'ic'
        icon.textContent = item.icon
        const text = document.createElement('span')
        text.append(item.label)
        const hint = document.createElement('small')
        hint.textContent = item.hint
        text.append(hint)
        b.append(icon, text)
        b.onmousedown = e => { e.preventDefault(); this.pick(item) }
        return b
      }))
      // Layout can't be read during an editor update: position the menu in the next measure cycle.
      const el = this.el
      this.view.requestMeasure({
        read: view => ({ at: view.coordsAtPos(open.from), w: el.offsetWidth, h: el.scrollHeight + el.offsetHeight - el.clientHeight }),
        write: ({ at, w, h }) => {
          if (!at) return
          el.style.left = Math.max(8, Math.min(innerWidth - w - 8, at.left)) + 'px'
          // Below the cursor if it fits, else above; if neither fits, the roomier side, scrolling.
          const below = innerHeight - at.bottom - 14, above = at.top - 14
          const down = h <= below || below >= above
          el.style.maxHeight = Math.min(h, down ? below : above) + 'px'
          el.style.top = (down ? at.bottom + 6 : at.top - 6 - Math.min(h, above)) + 'px'
          el.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
        },
      })
    }

    move(d: number) {
      if (!this.open) return false
      const n = this.matches().length
      this.open.index = (this.open.index + d + n) % n
      this.render()
      return true
    }

    pick(item?: SlashItem) {
      const open = this.open
      if (!open) return false
      item ??= this.matches()[open.index]
      this.close()
      item?.run(this.view, open.from, open.to)
      return true
    }

    close() {
      this.open = null
      this.el?.remove()
      this.el = null
    }

    destroy() { this.close(); if (plugin === this) plugin = null }
  }

  const keys = Prec.highest(keymap.of([
    { key: 'ArrowDown', run: () => plugin?.move(1) ?? false },
    { key: 'ArrowUp', run: () => plugin?.move(-1) ?? false },
    { key: 'Enter', run: () => plugin?.pick() ?? false },
    { key: 'Tab', run: () => plugin?.pick() ?? false },
    { key: 'Escape', run: () => { if (!plugin?.open) return false; plugin.close(); return true } },
  ]))

  return [ViewPlugin.define(view => new SlashPlugin(view)), keys]
}
