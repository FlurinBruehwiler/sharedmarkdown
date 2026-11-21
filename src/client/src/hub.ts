// Minimal SignalR client (JSON hub protocol over a WebSocket, negotiation skipped).
// Covers what we use: invoke, server-to-client calls, keep-alive and reconnect.
import type { Op, StateRun } from './rga'

const RS = '\x1e'

/** A tiny typed event emitter: event name -> argument list. Handlers run in the order they were added. */
export class Emitter<E extends { [K in keyof E]: unknown[] }> {
  readonly #handlers = new Map<keyof E, Set<(...args: never[]) => void>>()

  on<K extends keyof E>(name: K, fn: (...args: E[K]) => void): () => void {
    let set = this.#handlers.get(name)
    if (!set) this.#handlers.set(name, set = new Set())
    const h = fn as unknown as (...args: never[]) => void
    set.add(h)
    return () => { set.delete(h) }
  }

  emit<K extends keyof E>(name: K, ...args: E[K]) {
    for (const fn of this.#handlers.get(name) ?? []) (fn as unknown as (...args: E[K]) => void)(...args)
  }
}

/** Server-to-client calls (DocHub.cs / DocStore.cs): target -> arguments. */
export interface ClientEvents {
  ops: [ops: Op[]]
  /** A peer's cursor anchor; client is null when the peer left. */
  cursor: [peer: string, client: string | null, clock: number]
  peer: []
  deleted: []
  presence: [viewers: number]
}

/** Events the Hub raises itself: connected (handshake done, ready for calls), and online/offline. */
export interface ConnectionEvents {
  open: []
  status: [online: boolean]
}
export type HubEvents = ClientEvents & ConnectionEvents

export interface JoinResult { state: StateRun[], maxChars: number, maxImageDimension: number }
export type SubmitStatus = 'ok' | 'invalid' | 'size' | 'create' | 'rate' | 'readonly' | 'deleted'

/**
 * Why a hub method failed: the server's HubException messages (DocHub.cs), plus "offline" and
 * "closed" (no connection, or it dropped before the answer came).
 */
export type HubError = 'bad id' | 'rate' | 'not found' | 'deleted' | 'invalid' | 'create' | 'offline' | 'closed'
const HUB_ERRORS: readonly string[] = ['bad id', 'rate', 'not found', 'deleted', 'invalid', 'create', 'offline', 'closed'] satisfies HubError[]

export function hubError(e: unknown): HubError | null {
  return e instanceof Error && HUB_ERRORS.includes(e.message) ? e.message as HubError : null
}

/** Hub methods (DocHub.cs): target -> arguments and result. */
export interface ServerMethods {
  Version: { args: [], result: string }
  Join: { args: [id: string], result: JoinResult }
  /** Joins through a read-only link (/r/{readId}); Submit is then refused. */
  JoinRead: { args: [readId: string], result: JoinResult }
  /** The joined document's read-only link id (created on first request); editors only. */
  ReadLink: { args: [id: string], result: string }
  Submit: { args: [id: string, ops: Op[]], result: SubmitStatus }
  Cursor: { args: [client: string, clock: number], result: void }
}

const SERVER_EVENTS: { [K in keyof ClientEvents]: true } = { ops: true, cursor: true, peer: true, deleted: true, presence: true }

/** Hub protocol messages we receive (the handshake response is just `{}` or `{ error }`). */
type Incoming =
  | { type: 1, target: string, arguments: unknown[] }
  | { type: 3, invocationId: string, result?: unknown, error?: string }
  | { type: 6 }
  | { type: 7, error?: string }
  | { type?: undefined, error?: string }

type Outgoing =
  | { type: 1, target: string, arguments: unknown[], invocationId?: string }
  | { type: 6 }

interface Call { resolve: (result: unknown) => void, reject: (e: Error) => void }

export class Hub extends Emitter<HubEvents> {
  readonly url: string
  readonly calls = new Map<string, Call>()
  n = 0
  delay = 0
  connected = false
  ws!: WebSocket
  last = 0
  keepAliveTimer?: ReturnType<typeof setInterval>
  retryTimer?: ReturnType<typeof setTimeout>
  stopped = false

  constructor(url: string) {
    super()
    this.url = url.replace(/^http/, 'ws')
    this.connect()
    addEventListener('online', this.online)
    addEventListener('offline', this.offline)
  }

  /** Back online: reconnect now instead of waiting out the backoff (up to 10 s). */
  readonly online = () => {
    if (this.stopped || this.ws.readyState !== WebSocket.CLOSED) return // only while waiting to retry
    clearTimeout(this.retryTimer)
    this.delay = 0
    this.connect()
  }

  /** The OS says the network is gone: don't wait for the keep-alive timeout (35 s) to notice. */
  readonly offline = () => { if (this.connected) this.ws.close() }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    removeEventListener('online', this.online)
    removeEventListener('offline', this.offline)
    this.ws.close()
  }

  connect() {
    const ws = this.ws = new WebSocket(this.url)
    let buf = ''
    ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS)
    ws.onmessage = (e: MessageEvent<string>) => {
      buf += e.data
      for (let i; (i = buf.indexOf(RS)) >= 0; buf = buf.slice(i + 1)) this.recv(JSON.parse(buf.slice(0, i)))
    }
    ws.onclose = () => this.closed()
  }

  recv(m: Incoming) {
    this.last = Date.now()
    if (!this.connected) { // handshake response
      if ('error' in m && m.error) return this.ws.close()
      this.connected = true
      this.delay = 0
      this.keepAliveTimer = setInterval(() => {
        if (Date.now() - this.last > 35000) this.ws.close()
        else this.post({ type: 6 })
      }, 15000)
      this.emit('status', true)
      this.emit('open')
      return
    }
    if (m.type === 1) {
      if (m.target in SERVER_EVENTS) this.emit(m.target as keyof ClientEvents, ...m.arguments as never)
    } else if (m.type === 3) {
      const c = this.calls.get(m.invocationId)
      this.calls.delete(m.invocationId)
      if (c) m.error ? c.reject(new Error(m.error)) : c.resolve(m.result)
    } else if (m.type === 7) this.ws.close()
  }

  post(m: Outgoing) { this.ws.send(JSON.stringify(m) + RS) }

  send<K extends keyof ServerMethods>(target: K, ...args: ServerMethods[K]['args']) {
    if (this.connected) this.post({ type: 1, target, arguments: args })
  }

  invoke<K extends keyof ServerMethods>(target: K, ...args: ServerMethods[K]['args']) {
    return new Promise<ServerMethods[K]['result']>((resolve, reject) => {
      if (!this.connected) return reject(new Error('offline' satisfies HubError))
      const id = String(++this.n)
      // The completion's result has the type ServerMethods declares for this target.
      this.calls.set(id, { resolve: r => resolve(r as ServerMethods[K]['result']), reject })
      this.post({ type: 1, invocationId: id, target, arguments: args })
    })
  }

  closed() {
    const was = this.connected
    this.connected = false
    clearInterval(this.keepAliveTimer)
    for (const c of this.calls.values()) c.reject(new Error('closed' satisfies HubError))
    this.calls.clear()
    if (was) this.emit('status', false)
    if (this.stopped) return
    this.retryTimer = setTimeout(() => this.connect(), this.delay)
    this.delay = Math.min(this.delay * 2 || 500, 10000)
  }
}
