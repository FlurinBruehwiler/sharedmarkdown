// Documents kept on this device (IndexedDB) so they open and can be edited offline.
//
// Two object stores:
// - docs:    one record per document: the last known RGA state (server state plus our edits), its
//            text, and the base text (the same without our unsent edits, for merging them as text).
//            A cache: any tab may overwrite it. The newest MAX_DOCS are kept.
// - pending: unsent ops, one record per (document, tab). Each tab only writes its own record, so two
//            tabs editing the same document offline can't overwrite each other's edits. A tab that opens
//            a document adopts the records of tabs that are gone (closed, crashed) and sends their ops;
//            records of live tabs (they hold a Web Lock named after their RGA client id) are left to them.
// Ops are idempotent on the server, so sending one twice (e.g. a tab closed right after the ack,
// before its record was cleared) is harmless.
import { compactOps, type Op, type Rga, type StateRun } from './rga'

/** Bump when the stored op/state format changes; older records are then merged by text (using `base`). */
export const FORMAT = 1
const MAX_DOCS = 50

/** `base`: the text without this device's unsent edits; missing in records written before it existed. */
export interface DocRecord { key: string, v: number, state: StateRun[], text: string, base?: string, at: number }
/** A tab's unsent ops for a document; `name` is the record's own key ("{document key} {client}"). */
export interface PendingRecord { name: string, key: string, client: string, v: number, ops: Op[], at: number }

// As stored: the field names of the first version (`id` is the document key), so no schema upgrade is needed.
interface StoredDoc { id: string, v: number, state: StateRun[], text: string, base?: string, at: number }
interface StoredPending { key: string, id: string, client: string, v: number, ops: Op[], at: number }
const fromStoredDoc = ({ id, ...d }: StoredDoc): DocRecord => ({ key: id, ...d })
const toStoredDoc = ({ key, ...d }: DocRecord): StoredDoc => ({ id: key, ...d })
const fromStoredPending = (p: StoredPending): PendingRecord => ({ name: p.key, key: p.id, client: p.client, v: p.v, ops: p.ops, at: p.at })

const LOCK = 'sharedmarkdown-tab-'

function req<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error) })
}

export class LocalDocs {
  readonly client: string
  /** The database, or null where IndexedDB isn't available (some private modes): online-only then. */
  readonly db: Promise<IDBDatabase | null>
  lastEvict = 0

  constructor(client: string) {
    this.client = client
    this.db = new Promise(resolve => {
      try {
        const open = indexedDB.open('sharedmarkdown', 1)
        open.onupgradeneeded = () => {
          const db = open.result
          db.createObjectStore('docs', { keyPath: 'id' }).createIndex('at', 'at')
          db.createObjectStore('pending', { keyPath: 'key' }).createIndex('id', 'id')
        }
        open.onsuccess = () => resolve(open.result)
        open.onerror = open.onblocked = () => resolve(null)
      } catch { resolve(null) }
    })
    // Held until the tab goes away; other tabs use it to tell whether our pending ops are still ours to send.
    try { navigator.locks?.request(LOCK + client, () => new Promise<void>(() => {})).catch(() => {}) } catch {}
  }

  /** RGA client ids of other tabs that are still open (null if the browser can't tell). */
  async liveClients(): Promise<Set<string> | null> {
    try {
      const s = await navigator.locks.query()
      return new Set((s.held || []).map(l => l.name || '').filter(n => n.startsWith(LOCK)).map(n => n.slice(LOCK.length)))
    } catch { return null }
  }

  /** The cached document and the pending ops this tab should take over: its own, and those of closed tabs. */
  async load(key: string): Promise<{ doc: DocRecord | null, pending: PendingRecord[] }> {
    const db = await this.db
    if (!db) return { doc: null, pending: [] }
    try {
      const tx = db.transaction(['docs', 'pending'])
      const [doc, all] = await Promise.all([
        req(tx.objectStore('docs').get(key)) as Promise<StoredDoc | undefined>,
        req(tx.objectStore('pending').index('id').getAll(key)) as Promise<StoredPending[]>,
      ])
      const live = await this.liveClients()
      const pending = all.map(fromStoredPending).filter(p => p.client === this.client || !live?.has(p.client)).sort((a, b) => a.at - b.at)
      return { doc: doc ? fromStoredDoc(doc) : null, pending }
    } catch (e) {
      console.warn('Reading the copy on this device failed', e)
      return { doc: null, pending: [] }
    }
  }

  /**
   * Writes a document's state and this tab's pending ops in one transaction. Records in `adopted`
   * (pending records of closed tabs whose ops are now in `ops`) are removed in the same transaction.
   */
  async save(doc: DocRecord, ops: Op[], adopted: string[]) {
    const db = await this.db
    if (!db) return false
    const name = doc.key + ' ' + this.client
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    tx.objectStore('docs').put(toStoredDoc(doc))
    const pending = tx.objectStore('pending')
    if (ops.length) pending.put({ key: name, id: doc.key, client: this.client, v: FORMAT, ops, at: doc.at } satisfies StoredPending)
    else pending.delete(name)
    for (const k of adopted) if (k !== name) pending.delete(k)
    await done(tx)
    if (Date.now() - this.lastEvict > 60000) { this.lastEvict = Date.now(); this.evict().catch(e => console.warn('Evicting old copies failed', e)) }
    return true
  }

  /** Forgets a document on this device, unless it has edits that haven't reached the server yet. */
  async forget(key: string) {
    const db = await this.db
    if (!db) return
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    const n = await req(tx.objectStore('pending').index('id').count(key))
    if (!n) tx.objectStore('docs').delete(key)
    await done(tx)
  }

  async drop(key: string) {
    const db = await this.db
    if (!db) return
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    tx.objectStore('docs').delete(key)
    const names = await req(tx.objectStore('pending').index('id').getAllKeys(key))
    for (const k of names) tx.objectStore('pending').delete(k)
    await done(tx)
  }

  async evict() {
    const db = await this.db
    if (!db) return
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    const keep = new Set((await req(tx.objectStore('pending').getAll()) as StoredPending[]).map(p => p.id))
    const keys = await req(tx.objectStore('docs').index('at').getAllKeys()) as string[] // oldest first
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_DOCS))) if (!keep.has(key)) tx.objectStore('docs').delete(key)
    await done(tx)
  }

  async orphans(except: string | null): Promise<Map<string, PendingRecord[]>> {
    const db = await this.db
    const out = new Map<string, PendingRecord[]>()
    if (!db) return out
    const all = (await req(db.transaction('pending').objectStore('pending').getAll()) as StoredPending[]).map(fromStoredPending)
    if (!all.length) return out
    const live = await this.liveClients()
    for (const p of all.sort((a, b) => a.at - b.at)) {
      if (p.key === except || (p.client !== this.client && live?.has(p.client))) continue
      out.set(p.key, [...out.get(p.key) || [], p])
    }
    return out
  }

  async doc(key: string): Promise<DocRecord | null> {
    const db = await this.db
    if (!db) return null
    const doc = await req(db.transaction('docs').objectStore('docs').get(key)) as StoredDoc | undefined
    return doc ? fromStoredDoc(doc) : null
  }

  /** After `sent` reached the server: removes those pending records unless they changed meanwhile, and refreshes the cached state. */
  async synced(sent: PendingRecord[], doc: DocRecord | null) {
    const db = await this.db
    if (!db) return
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    const store = tx.objectStore('pending')
    for (const p of sent) {
      const now = await req(store.get(p.name)) as StoredPending | undefined
      if (now && now.at === p.at) store.delete(p.name)
    }
    if (doc) tx.objectStore('docs').put(toStoredDoc(doc))
    await done(tx)
  }
}

// ---------- the open document's copy ----------
// Kept up to date by DocSync: saved shortly after every change, and right away when the tab is hidden or closed.


export interface Snapshot { doc: DocRecord, ops: Op[], adopted: string[], version: number }
/** The open document's state; null while there's nothing to save (loading, switching, deleted). */
export type Source = () => { rga: Rga, pending: Op[] } | null

export class LocalCopy {
  readonly store: LocalDocs
  readonly source: Source
  readonly onChange: () => void
  key = ''
  /** Pending records of closed tabs whose ops are in our outbox; removed when we next save ours. */
  adopted: string[] = []
  /** Whether the latest state and unsent ops are on disk (so closing the tab loses nothing). */
  saved = true
  /** Counts changes, so a write only marks the copy saved if nothing changed while it ran. */
  version = 0
  lastAt = 0
  persistTimer?: ReturnType<typeof setTimeout>
  warned = false

  constructor(store: LocalDocs, source: Source, onChange: () => void) {
    this.store = store
    this.source = source
    this.onChange = onChange
  }

  reset(key: string, adopted: string[]) {
    clearTimeout(this.persistTimer)
    this.key = key
    this.adopted = adopted
    this.saved = true
  }

  snapshot(): Snapshot | null {
    const src = this.source()
    if (!src) return null
    const at = this.lastAt = Math.max(Date.now(), this.lastAt + 1)
    const ops = compactOps(src.pending)
    return {
      doc: { key: this.key, v: FORMAT, state: src.rga.encode(), text: src.rga.text(), base: src.rga.textWithout(ops), at },
      ops,
      adopted: [...this.adopted],
      version: this.version,
    }
  }

  async write(snap: Snapshot) {
    let ok = false
    try { ok = await this.store.save(snap.doc, snap.ops, snap.adopted) } catch (e) {
      if (!this.warned) console.warn('Saving the document on this device failed', e)
      this.warned = true
    }
    if (ok && snap.doc.key === this.key) {
      this.adopted = this.adopted.filter(k => !snap.adopted.includes(k))
      if (snap.version === this.version) this.saved = true
    }
    this.onChange()
  }

  changed() {
    if (!this.source()) return
    this.version++
    this.saved = false
    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => this.persist(), 300)
    this.onChange()
  }

  persist() {
    clearTimeout(this.persistTimer)
    const snap = this.snapshot()
    return snap ? this.write(snap) : Promise.resolve()
  }
}
