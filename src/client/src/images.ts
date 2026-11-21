// Images pasted, dropped or picked: shrunk in the browser, uploaded to /api/blobs, and shown at
// once from the local file while the upload runs.
import { ViewPlugin, type EditorView } from '@codemirror/view'
import { randomId } from './ids'

/** What image insertion needs from the app. */
export interface ImageContext {
  /** Whether the hub is connected (uploads need the server). */
  online: () => boolean
  /** The server's size limit (longest side, px). */
  maxDimension: () => number
  notice: (message: string, ms?: number) => void
}

/**
 * Images pasted in this tab, by markdown src: `upload:<token>` while uploading, then the final
 * `/b/<id>`. They show the local copy at once and keep it after the upload, so the image never
 * flickers or downloads again for the person who pasted it.
 */
export const localImages = new Map<string, string>()

/** Upload placeholders are `upload:<unix ms>-<random>`, so everyone can tell how old one is. */
const uploadSrc = () => `upload:${Date.now()}-${randomId(6)}`
/** When the upload behind an `upload:` src started (ms), or null if `src` isn't one. */
export function uploadStarted(src: string) {
  const m = /^upload:(\d+)-/.exec(src)
  return m ? Number(m[1]) : null
}

/**
 * Shrinks an image in the browser before uploading: scales it to the server's size limit and
 * re-encodes photos as JPEG. Browsers put copied images on the clipboard as PNG, which for a
 * photo is ~10x larger than the original JPEG. The server still validates and re-encodes
 * everything; this only saves the transfer.
 */
async function shrinkImage(file: File, maxDimension: number): Promise<Blob> {
  if (file.type === 'image/gif') return file // keep animations
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file) } // applies EXIF rotation
  catch { return file } // not decodable here; let the server decide
  try {
    const { width, height } = bitmap
    const scale = Math.min(1, maxDimension / Math.max(width, height))
    // Photos compress badly as PNG (> 1 byte per pixel); screenshots stay PNG for crisp text.
    const photoPng = file.type === 'image/png' && file.size / (width * height) > 1
    if (scale === 1 && !photoPng) return file
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    let type = file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png'
    if (photoPng && isOpaque(ctx, w, h)) type = 'image/jpeg'
    const out = await canvas.convertToBlob({ type, quality: 0.85 })
    return out.size < file.size ? out : file
  } finally { bitmap.close() }
}

function isOpaque(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  const data = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false
  return true
}

async function uploadImage(file: File, maxDimension: number) {
  const body = await shrinkImage(file, maxDimension)
  const r = await fetch('/api/blobs', { method: 'POST', headers: { 'content-type': body.type || file.type }, body })
  if (!r.ok) throw new Error(await r.text())
  const { url }: { url: string } = await r.json()
  return url
}

/** Replaces the markdown src `from` with `to` wherever it currently is (the text may have moved); null removes the image. */
function replaceSrc(view: EditorView, from: string, to: string | null) {
  const doc = view.state.doc.toString()
  const changes = []
  const re = new RegExp(String.raw`!\[[^\]]*\]\(${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\)`, 'g')
  for (const m of doc.matchAll(re)) {
    const at = m.index
    changes.push(to === null
      ? { from: at, to: at + m[0].length }
      : { from: at + m[0].length - from.length - 1, to: at + m[0].length - 1, insert: to })
  }
  if (changes.length) view.dispatch({ changes })
}

/**
 * Inserts the images among `files` at the selection, or on their own line at `at` (dropped). An
 * `upload:` placeholder src is inserted and shown with the local file; when the upload is done the
 * src becomes the real `/b/<id>` URL. Other people see "Uploading image…" in the meantime.
 * Returns false if there were no images.
 */
export function insertImages(ctx: ImageContext, view: EditorView, files: FileList, at?: number) {
  const images = Array.from(files).filter(f => f.type.startsWith('image/'))
  if (!images.length) return false
  const offlineMessage = "You're offline; images can be added when you're back online."
  if (!ctx.online()) { ctx.notice(offlineMessage, 6000); return true }
  const inserts = images.map(f => {
    const token = uploadSrc()
    const preview = URL.createObjectURL(f)
    localImages.set(token, preview)
    const alt = (f.name || 'image').replace(/[\[\]]/g, '').replace(/\.\w+$/, '')
    return { f, token, preview, md: `![${alt}](${token})` }
  })
  const md = inserts.map(i => i.md).join('\n')
  if (at == null) view.dispatch(view.state.replaceSelection(md))
  else insertOnOwnLine(view, at, md)
  for (const { f, token, preview } of inserts)
    uploadImage(f, ctx.maxDimension()).then(url => {
      localImages.set(url, preview)
      localImages.delete(token)
      replaceSrc(view, token, url)
    }, (e: Error) => {
      localImages.delete(token)
      URL.revokeObjectURL(preview)
      replaceSrc(view, token, null)
      ctx.notice(e instanceof TypeError || !ctx.online() ? offlineMessage : 'Upload failed: ' + e.message, 6000) // fetch fails with a TypeError
    })
  return true
}

/** Inserts dropped markdown at `at` on line(s) of its own, rather than splitting a word or sentence inline. */
export function insertOnOwnLine(view: EditorView, at: number, md: string) {
  const line = view.state.doc.lineAt(at)
  // Splitting a line between words: the space there goes, not onto the start of the next line.
  const before = line.text.slice(0, at - line.from), after = line.text.slice(at - line.from)
  const from = before.trim() ? line.from + before.trimEnd().length : at
  const to = after.trim() ? line.to - after.trimStart().length : at
  const insert = (from > line.from ? '\n' : '') + md + (to < line.to ? '\n' : '')
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.drop' })
  view.focus()
}

/** Opens the file picker and inserts the chosen images at the selection. */
export function pickImages(ctx: ImageContext, view: EditorView) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/gif,image/webp'
  input.multiple = true
  input.onchange = () => { if (input.files?.length) insertImages(ctx, view, input.files) }
  input.click()
}

/**
 * The text position nearest to a pointer anywhere over the document area: the margins map to the
 * nearest line, the space below the text to its end. Null outside the document area (sidebar, header).
 */
export function dropPos(view: EditorView, e: MouseEvent): number | null {
  if (!(e.target instanceof Element) || !e.target.closest('main') || e.target.closest('header')) return null
  const r = view.contentDOM.getBoundingClientRect()
  if (e.clientY >= r.bottom) return view.state.doc.length
  if (e.clientY < r.top) return 0
  return view.posAtCoords({ x: Math.min(Math.max(e.clientX, r.left + 1), r.right - 1), y: e.clientY }, false)
}

/** A drag that carries files from outside the page (the desktop, a file manager). */
const draggingFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')

/**
 * An image dragged from another web page arrives as its URL (and HTML), not as a file. Only
 * https images are taken, linked where they are (the page's CSP allows https images).
 */
function droppedImage(data: DataTransfer) {
  const url = data.getData('text/uri-list').split(/\r?\n/).find(l => l && !l.startsWith('#'))
  if (!url?.startsWith('https://')) return null
  const img = new DOMParser().parseFromString(data.getData('text/html'), 'text/html').querySelector('img')
  if (!img || (img.src !== url && img.getAttribute('src') !== url)) return null // a dragged link or text, not an image
  const src = url.replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
  return `![${img.alt.replace(/[\[\]\n]/g, '')}](${src})`
}

const dragEvents = ['dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend'] as const

/**
 * Dropping image files anywhere over the document inserts them at the drop caret. Listens on the
 * window in the capture phase, ahead of CodeMirror, whose own drop handling only sees drops on
 * the text itself (not on images, the margins or the space below the text, where the browser
 * would open the file instead, leaving the document) and would insert a file's bytes as text.
 */
export function fileDrops(ctx: ImageContext) {
  return ViewPlugin.fromClass(class {
    view: EditorView
    caret: HTMLElement | null = null
    fromPage = false
    constructor(view: EditorView) {
      this.view = view
      for (const t of dragEvents) window.addEventListener(t, this, true)
    }
    destroy() {
      for (const t of dragEvents) window.removeEventListener(t, this, true)
      this.showCaret(null)
    }
    handleEvent(e: DragEvent) {
      if (e.type === 'dragstart') this.fromPage = true // moving text or images within the document is CodeMirror's
      if (e.type === 'dragend') this.fromPage = false
      if (e.type === 'dragend' || (e.type === 'dragleave' && !e.relatedTarget)) return this.showCaret(null)
      if (!draggingFiles(e)) {
        if (e.type === 'drop' && !this.fromPage) this.dropImageLink(e)
        return
      }
      if (e.type === 'dragleave') return
      // Never let the browser open a file dropped on the page: it would navigate away from the document.
      e.preventDefault()
      if (this.view.state.readOnly) { e.dataTransfer!.dropEffect = 'none'; return } // view-only link: nothing to add
      const pos = dropPos(this.view, e)
      if (e.type !== 'drop') {
        e.dataTransfer!.dropEffect = pos == null ? 'none' : 'copy'
        return this.showCaret(pos)
      }
      this.showCaret(null)
      const files = e.dataTransfer!.files
      if (!files.length) return this.dropImageLink(e) // Firefox: an image from a web page, as a file promise
      if (pos == null) return
      const images = insertImages(ctx, this.view, files, pos)
      if (!images || Array.from(files).some(f => !f.type.startsWith('image/'))) ctx.notice('Only images can be added', 3000)
    }
    dropImageLink(e: DragEvent) {
      if (this.view.state.readOnly) return
      const md = e.dataTransfer && droppedImage(e.dataTransfer)
      const pos = md ? dropPos(this.view, e) : null
      if (!md || pos == null) return
      e.preventDefault()
      insertOnOwnLine(this.view, pos, md)
    }
    showCaret(pos: number | null) {
      const at = pos == null ? null : this.view.coordsAtPos(pos)
      if (!at) {
        this.caret?.remove()
        this.caret = null
        return
      }
      this.caret ??= this.view.scrollDOM.appendChild(Object.assign(document.createElement('div'), { className: 'cm-fileDropCursor' }))
      const outer = this.view.scrollDOM.getBoundingClientRect()
      Object.assign(this.caret.style, { left: at.left - outer.left + 'px', top: at.top - outer.top + 'px', height: at.bottom - at.top + 'px' })
    }
  })
}
