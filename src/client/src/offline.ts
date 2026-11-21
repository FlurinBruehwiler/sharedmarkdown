// Offline support around DocSync: the service worker (sw.ts) that makes the page load without a
// network, the status line, saving on tab close, and sending edits that were left on this device
// for documents that aren't open anywhere.
import { Hub, hubError } from './hub'
import { FORMAT } from './local'
import { Rga, compactOps, firstBatch, type Op } from './rga'
import { mergeText, rebase, replicaOf, type DocSync } from './sync'
import { isReadKey, randomId } from './ids'


export function setupOffline(hub: Hub, sync: DocSync) {
  // http only on localhost (service workers need a secure context anyway).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
    addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(e => console.warn('Service worker registration failed', e)) })

  // ---------- status line ----------
  const status = document.getElementById('status')!
  let stored = false // whether this device can keep documents (IndexedDB)
  sync.store.db.then(db => { stored = !!db; update() })
  let grace = navigator.onLine !== false // don't flash "offline" while the first connection is made
  setTimeout(() => { grace = false; update() }, 1500)
  let away = false // was offline, edits may still be on their way
  function update() {
    const offline = !hub.connected && !grace
    if (offline) away = true
    else if (hub.connected && sync.loaded && !sync.dirty) away = false
    const syncing = !offline && away && hub.connected && sync.dirty
    document.body.classList.toggle('offline', offline)
    document.body.classList.toggle('syncing', syncing)
    const text = offline
      ? sync.readOnly ? 'Offline — showing the last version seen on this device'
      : stored ? "Offline — changes are saved on this device and sync when you're back online"
        : "Offline — keep this tab open; changes sync when you're back online"
      : syncing ? 'Back online, syncing…' : ''
    if (status.textContent !== text) { status.textContent = text; status.title = text }
  }
  hub.on('status', update)
  sync.on('change', update)
  addEventListener('online', update)
  addEventListener('offline', update)

  // ---------- keep edits when the tab closes ----------
  // Unsent edits are on disk at most ~300 ms after typing; write them right away when the tab goes away.
  addEventListener('pagehide', () => { sync.copy.persist() })
  document.addEventListener('visibilitychange', () => { if (document.hidden) sync.copy.persist() })
  addEventListener('beforeunload', e => {
    if (!sync.unsaved) return
    sync.copy.persist()
    if (!stored) e.preventDefault() // nowhere to keep them: ask before closing, as before
  })

  // ---------- documents with edits left on this device ----------
  let running = false
  /** Sends unsent ops of documents not open in any tab (edited offline, then left), over a second connection. */
  async function syncOthers() {
    if (running) return
    running = true
    let bg: Hub | null = null
    try {
      const docs = await sync.store.orphans(sync.key)
      if (!docs.size) return
      bg = new Hub(location.origin + '/hub')
      const conn = bg
      await new Promise<void>((resolve, reject) => { conn.on('open', resolve); setTimeout(() => reject(new Error('timeout')), 10000) })
      for (const [key, pending] of docs) {
        if (key === sync.key) continue // opened meanwhile: DocSync adopts them
        if (isReadKey(key)) continue // view-only links never have edits to send
        let state
        try { state = (await bg.invoke('Join', key)).state } catch (e) {
          if (hubError(e) !== 'deleted') throw e
          // Deleted by an administrator: drop the edits rather than recreating the document.
          sync.documentDeleted(key)
          continue
        }
        const client = randomId(10)
        const server = new Rga(client)
        server.load(state)
        const doc = await sync.store.doc(key)
        let ops: Op[]
        if (pending.every(p => p.v === FORMAT)) {
          const all = pending.flatMap(p => p.ops)
          ops = rebase(server, all, doc && doc.v === FORMAT ? replicaOf(client, doc.state, all) : null)
        } else {
          // Stored in an older format: merge this device's text instead (its base is what it was made on).
          ops = doc ? mergeText(server, doc.base ?? server.text(), doc.text) : []
        }
        let left: Op[] = compactOps(ops), result = 'ok'
        while (left.length && result === 'ok') {
          const [batch, rest] = firstBatch(left)
          result = await bg.invoke('Submit', key, batch)
          left = rest
        }
        if (result === 'deleted') { sync.documentDeleted(key); continue }
        if (result !== 'ok') { console.warn(`Unsent edits of ${key} were refused (${result}); trying again later`); continue }
        const text = server.text()
        await sync.store.synced(pending, doc && { ...doc, v: FORMAT, state: server.encode(), text, base: text })
      }
    } catch (e) {
      console.warn('Sending edits kept on this device failed; trying again on the next reconnect', e)
    } finally {
      bg?.stop()
      running = false
    }
  }
  return { syncOthers }
}
