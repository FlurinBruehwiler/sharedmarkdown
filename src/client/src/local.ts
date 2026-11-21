// Documents kept on this device (IndexedDB) so they open and can be edited offline.
//
// Two object stores:
// - docs:    one record per document: the last known RGA state (server state plus our edits) and its text.
//            A cache: any tab may overwrite it. The newest MAX_DOCS are kept.
// - pending: unsent ops, one record per (document, tab). Each tab only writes its own record, so two
//            tabs editing the same document offline can't overwrite each other's edits. A tab that opens
//            a document adopts the records of tabs that are gone (closed, crashed) and sends their ops;
//            records of live tabs (they hold a Web Lock named after their RGA client id) are left to them.
// Ops are idempotent on the server, so sending one twice (e.g. a tab closed right after the ack,
// before its record was cleared) is harmless.
import type { Op, StateRun } from './rga'

/** Bump when the stored op/state format changes; older records are then merged by text. */
export const FORMAT = 1
const MAX_DOCS = 50

export interface DocRecord { id: string, v: number, state: StateRun[], text: string, at: number }
export interface PendingRecord { key: string, id: string, client: string, v: number, ops: Op[], at: number }

const LOCK = 'sharedmarkdown-tab-'

function req<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error) })
}

export class LocalDocs {
  readonly client: string
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
      } catch { resolve(null) } // no IndexedDB (some private modes): online-only, as before
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
  async load(id: string): Promise<{ doc: DocRecord | null, pending: PendingRecord[] }> {
    const db = await this.db
    if (!db) return { doc: null, pending: [] }
    try {
      const tx = db.transaction(['docs', 'pending'])
      const [doc, all] = await Promise.all([
        req(tx.objectStore('docs').get(id)) as Promise<DocRecord | undefined>,
        req(tx.objectStore('pending').index('id').getAll(id)) as Promise<PendingRecord[]>,
      ])
      const live = await this.liveClients()
      const pending = all.filter(p => p.client === this.client || !live?.has(p.client)).sort((a, b) => a.at - b.at)
      return { doc: doc ?? null, pending }
    } catch { return { doc: null, pending: [] } }
  }

  /**
   * Writes a document's state and this tab's pending ops in one transaction. Records in `adopted`
   * (pending records of closed tabs whose ops are now in `ops`) are removed in the same transaction.
   */
  async save(doc: DocRecord, ops: Op[], adopted: string[]) {
    const db = await this.db
    if (!db) return false
    const key = doc.id + ' ' + this.client
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    tx.objectStore('docs').put(doc)
    const pending = tx.objectStore('pending')
    if (ops.length) pending.put({ key, id: doc.id, client: this.client, v: FORMAT, ops, at: doc.at } satisfies PendingRecord)
    else pending.delete(key)
    for (const k of adopted) if (k !== key) pending.delete(k)
    await done(tx)
    if (Date.now() - this.lastEvict > 60000) { this.lastEvict = Date.now(); this.evict().catch(() => {}) }
    return true
  }

  /** Forgets a document on this device, unless it has edits that haven't reached the server yet. */
  async forget(id: string) {
    const db = await this.db
    if (!db) return
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    const n = await req(tx.objectStore('pending').index('id').count(id))
    if (!n) tx.objectStore('docs').delete(id)
    await done(tx)
  }

  /** Drops everything about a document, pending ops included (it was deleted on the server). */
  async drop(id: string) {
    const db = await this.db
    if (!db) return
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    tx.objectStore('docs').delete(id)
    const keys = await req(tx.objectStore('pending').index('id').getAllKeys(id))
    for (const k of keys) tx.objectStore('pending').delete(k)
    await done(tx)
  }

  /** Keeps the MAX_DOCS most recently used documents, and any document with unsent edits. */
  async evict() {
    const db = await this.db
    if (!db) return
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    const keep = new Set((await req(tx.objectStore('pending').getAll()) as PendingRecord[]).map(p => p.id))
    const ids = await req(tx.objectStore('docs').index('at').getAllKeys()) as string[] // oldest first
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_DOCS))) if (!keep.has(id)) tx.objectStore('docs').delete(id)
    await done(tx)
  }

  /** Pending ops of documents other than `except` that no open tab is responsible for, grouped by document. */
  async orphans(except: string | null): Promise<Map<string, PendingRecord[]>> {
    const db = await this.db
    const out = new Map<string, PendingRecord[]>()
    if (!db) return out
    let all: PendingRecord[]
    try { all = await req(db.transaction('pending').objectStore('pending').getAll()) } catch { return out }
    if (!all.length) return out
    const live = await this.liveClients()
    for (const p of all.sort((a, b) => a.at - b.at)) {
      if (p.id === except || (p.client !== this.client && live?.has(p.client))) continue
      out.set(p.id, [...out.get(p.id) || [], p])
    }
    return out
  }

  async doc(id: string): Promise<DocRecord | null> {
    const db = await this.db
    if (!db) return null
    try { return (await req(db.transaction('docs').objectStore('docs').get(id))) ?? null } catch { return null }
  }

  /** After `sent` reached the server: removes those pending records unless they changed meanwhile, and refreshes the cached state. */
  async synced(sent: PendingRecord[], doc: DocRecord | null) {
    const db = await this.db
    if (!db) return
    const tx = db.transaction(['docs', 'pending'], 'readwrite')
    const store = tx.objectStore('pending')
    for (const p of sent) {
      const now = await req(store.get(p.key)) as PendingRecord | undefined
      if (now && now.at === p.at) store.delete(p.key)
    }
    if (doc) tx.objectStore('docs').put(doc)
    await done(tx)
  }
}
