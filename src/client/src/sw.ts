// Service worker: lets the page load without a network. Built by build.mjs to /sw.js (not hashed,
// so its scope is the whole site); the bundle name is baked in, so every deploy is a new worker.
//
// - Pages (/ and /{id}, all the same index.html): network first, so a deploy is picked up at once;
//   the last page seen is kept and served when the network fails (or hangs for 5 s).
// - /assets/* (content-hashed, immutable): cache first, one cache per build; old builds' caches are
//   deleted when a new worker activates.
// - /b/* images (content-addressed, immutable): cache first, the most recent 200 kept.
// Everything else (the hub, /api, the admin dashboard, /_blazor, /_framework…) isn't touched.
export {}

declare const __BUILD__: string // a hash of this build (build.mjs)

interface ExtendableEvent extends Event { waitUntil(p: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { readonly request: Request, respondWith(r: Response | Promise<Response>): void }
interface Scope {
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  location: Location
}
const sw = self as unknown as Scope

const CACHE = 'sm-build-' + __BUILD__
const IMAGES = 'sm-images'
const SHELL = '/' // every page is the same index.html; kept under this key
const ID = /^\/[A-Za-z0-9]{8,32}$/
/** View-only links (/r/{16-char read id}) are the same page. */
const READ_ID = /^\/r\/[A-Za-z0-9]{16}$/
const MAX_IMAGES = 200

sw.addEventListener('install', e => e.waitUntil((async () => {
  const cache = await caches.open(CACHE)
  const shell = await fetch(SHELL, { cache: 'no-cache' })
  if (!shell.ok) throw new Error('shell ' + shell.status)
  // The bundle this page uses and the chunks it imports up front (language parsers load later, on
  // demand, and are cached then). All are content-addressed, so the HTTP cache copy (if any) is right.
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(await shell.clone().text())?.[1]
  if (js) await precacheModule(cache, new URL(js, sw.location.origin).href)
  await cache.put(SHELL, shell)
  await sw.skipWaiting() // nothing in the old worker is worth waiting for: take over at once
})()))

async function precacheModule(cache: Cache, url: string, seen = new Set<string>()): Promise<void> {
  if (seen.has(url)) return
  seen.add(url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(url + ' ' + res.status)
  await cache.put(url, res.clone())
  const imports = [...(await res.text()).matchAll(/(?:from|import)\s*"(\.\.?\/[^"]+\.js)"/g)].map(m => new URL(m[1], url).href)
  await Promise.all(imports.map(i => precacheModule(cache, i, seen)))
}

sw.addEventListener('activate', e => e.waitUntil((async () => {
  for (const name of await caches.keys())
    if (name.startsWith('sm-build-') && name !== CACHE) await caches.delete(name)
  await sw.clients.claim()
})()))

sw.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== sw.location.origin) return
  if (req.mode === 'navigate') {
    if (url.pathname === '/' || ID.test(url.pathname) || READ_ID.test(url.pathname)) e.respondWith(page(req))
  } else if (url.pathname.startsWith('/assets/')) e.respondWith(cacheFirst(req, CACHE, 0))
  else if (url.pathname.startsWith('/b/')) e.respondWith(cacheFirst(req, IMAGES, MAX_IMAGES))
})

async function page(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE)
  const cached = () => cache.match(SHELL, { ignoreVary: true })
  const net = fetch(req).then(res => {
    if (res.ok && res.headers.get('content-type')?.startsWith('text/html')) cache.put(SHELL, res.clone()).catch(() => {})
    return res
  })
  try {
    // A hanging network ("lie-fi") falls back to the stored page after 5 s; without one, keep waiting.
    const slow = new Promise<Response>(resolve => setTimeout(async () => resolve(await cached() ?? net), 5000))
    return await Promise.race([net, slow])
  } catch {
    return await cached() ?? Response.error()
  }
}

async function cacheFirst(req: Request, name: string, max: number): Promise<Response> {
  const cache = await caches.open(name)
  const hit = await cache.match(req, { ignoreVary: true })
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok && res.type === 'basic') {
    await cache.put(req, res.clone()).catch(() => {})
    if (max) {
      const keys = await cache.keys() // oldest first
      for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k)
    }
  }
  return res
}
