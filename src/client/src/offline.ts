// Offline support around DocSync: the service worker (sw.ts) that makes the page load without a
// network, the status line, saving on tab close, and sending edits that were left on this device
// for documents that aren't open anywhere.
import { Hub } from './hub'
import { FORMAT } from './local'
import { Rga, applyAll, compactOps, diff, firstBatch, type Op } from './rga'
import type { DocSync } from './sync'

export function setupOffline(hub: Hub, sync: DocSync) {
  // http only on localhost (service workers need a secure context anyway).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
    addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })

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
      ? stored ? "Offline — changes are saved on this device and sync when you're back online"
        : "Offline — keep this tab open; changes sync when you're back online"
      : syncing ? 'Back online, syncing…' : ''
    if (status.textContent !== text) { status.textContent = text; status.title = text }
  }
  hub.onstatus = online => {
    update()
    if (!online) sync.persist()
  }
  sync.onchange = update
  addEventListener('online', update)
  addEventListener('offline', update)

  // ---------- keep edits when the tab closes ----------
  // Unsent edits are on disk at most ~300 ms after typing; write them right away when the tab goes away.
  addEventListener('pagehide', () => { sync.persist() })
  document.addEventListener('visibilitychange', () => { if (document.hidden) sync.persist() })
  addEventListener('beforeunload', e => {
    if (!sync.unsaved) return
    sync.persist()
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
      const docs = await sync.store.orphans(sync.id)
      if (!docs.size) return
      bg = new Hub(location.origin + '/hub')
      const conn = bg
      await new Promise<void>((resolve, reject) => { conn.onopen = resolve; setTimeout(() => reject(new Error('timeout')), 10000) })
      for (const [id, pending] of docs) {
        if (id === sync.id) continue // opened meanwhile: DocSync adopts them
        const res = await bg.invoke('Join', id)
        const rga = new Rga(randomClient())
        rga.load(res.state)
        const ops = pending.flatMap(p => p.v === FORMAT ? p.ops : [])
        const { ok, applied } = applyAll(rga, ops)
        const doc = await sync.store.doc(id)
        if (!ok || ops.length < pending.reduce((n, p) => n + p.ops.length, 0)) {
          // Compacted on the server since (or an old format): merge this device's text instead.
          if (!doc) continue
          const d = diff(rga.text(), doc.text)
          applied.push(...rga.splice(d.p, d.d, d.i))
        }
        let left: Op[] = compactOps(applied), failed = false
        while (left.length && !failed) {
          const [batch, rest] = firstBatch(left)
          failed = await bg.invoke('Submit', id, batch) !== 'ok'
          left = rest
        }
        if (failed) continue // rate limits and the like: try again on the next reconnect
        await sync.store.synced(pending, doc && { ...doc, v: FORMAT, state: rga.encode(), text: rga.text() })
      }
    } catch {} finally {
      bg?.stop()
      running = false
    }
  }
  return { syncOthers }
}

function randomClient() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}
