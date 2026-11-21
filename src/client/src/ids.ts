// Document keys and random ids.
//
// A document is named by its key everywhere (URL path, sidebar, sync, this device's copy): its edit
// id, or "r/{readId}" for one opened through a read-only link. The two never collide: edit ids have no slash.

/** An edit link's path: /{id}. */
export const ID = /^\/([A-Za-z0-9]{8,32})$/
/** A read-only link's path: /r/{readId}. */
export const READ = /^\/r\/([A-Za-z0-9]{16})$/

/** The key of the document a path opens, or null if the path isn't a document. */
export function docKey(path: string) {
  const m = path.match(ID) ?? path.match(READ)
  return m ? m[0].slice(1) : null
}

export const isReadKey = (key: string) => key.startsWith('r/')
/** The read id of a read-only key ("r/{readId}"). */
export const readIdOf = (key: string) => key.slice(2)

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** `n` random base62 characters, uniformly distributed (bytes >= 248 are dropped rather than wrapped). */
export function randomId(n: number) {
  let s = ''
  while (s.length < n) for (const b of crypto.getRandomValues(new Uint8Array(n))) if (b < 248 && s.length < n) s += ALPHABET[b % 62]
  return s
}

/** A new document's edit id (~71 bits). */
export const newDocId = () => randomId(12)
