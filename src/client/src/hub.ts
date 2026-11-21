// Minimal SignalR client (JSON hub protocol over a WebSocket, negotiation skipped).
// Covers what we use: invoke, server-to-client calls, keep-alive and reconnect.
import type { Op, StateRun } from './rga'

const RS = '\x1e'

/** Server-to-client calls (DocHub.cs / DocStore.cs): target -> arguments. */
export interface ClientEvents {
  ops: [ops: Op[]]
  /** A peer's cursor anchor; client is null when the peer left. */
  cursor: [peer: string, client: string | null, clock: number]
  peer: []
  deleted: []
  presence: [viewers: number]
}

export interface JoinResult { state: StateRun[], maxChars: number, maxImageDimension: number }
/** "ok", or why the batch was refused. */
export type SubmitStatus = 'ok' | 'invalid' | 'size' | 'create' | 'rate'

/** Hub methods (DocHub.cs): target -> arguments and result. */
export interface ServerMethods {
  Version: { args: [], result: string }
  Join: { args: [id: string], result: JoinResult }
  Submit: { args: [id: string, ops: Op[]], result: SubmitStatus }
  Cursor: { args: [client: string, clock: number], result: void }
}

/** Handlers by target; on() ties each to its ClientEvents argument list. */
type Handlers = { [target: string]: ((...args: never) => void) | undefined }

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

export class Hub {
  readonly url: string
  handlers: Handlers
  calls: Map<string, Call>
  n: number
  delay: number
  connected: boolean
  onopen: (() => void) | null
  onstatus: ((online: boolean) => void) | null
  ws!: WebSocket // assigned by connect(), which the constructor calls
  last = 0 // time of the last message received
  timer?: ReturnType<typeof setInterval>

  constructor(url: string) {
    this.url = url.replace(/^http/, 'ws')
    this.handlers = {}
    this.calls = new Map()
    this.n = 0
    this.delay = 0
    this.connected = false
    this.onopen = null
    this.onstatus = null
    this.connect()
  }

  on<K extends keyof ClientEvents>(name: K, fn: (...args: ClientEvents[K]) => void) { this.handlers[name] = fn }

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
      this.timer = setInterval(() => {
        if (Date.now() - this.last > 35000) this.ws.close()
        else this.post({ type: 6 })
      }, 15000)
      this.onstatus?.(true)
      this.onopen?.()
      return
    }
    if (m.type === 1) {
      // The server sends the arguments ClientEvents declares for each target.
      const fn = this.handlers[m.target] as ((...args: unknown[]) => void) | undefined
      fn?.(...m.arguments)
    } else if (m.type === 3) {
      const c = this.calls.get(m.invocationId)
      this.calls.delete(m.invocationId)
      if (c) m.error ? c.reject(new Error(m.error)) : c.resolve(m.result)
    } else if (m.type === 7) this.ws.close()
  }

  post(m: Outgoing) { this.ws.send(JSON.stringify(m) + RS) }

  /** Fire-and-forget call. */
  send<K extends keyof ServerMethods>(target: K, ...args: ServerMethods[K]['args']) {
    if (this.connected) this.post({ type: 1, target, arguments: args })
  }

  invoke<K extends keyof ServerMethods>(target: K, ...args: ServerMethods[K]['args']) {
    return new Promise<ServerMethods[K]['result']>((resolve, reject) => {
      if (!this.connected) return reject(new Error('offline'))
      const id = String(++this.n)
      // The completion's result has the type ServerMethods declares for this target.
      this.calls.set(id, { resolve: r => resolve(r as ServerMethods[K]['result']), reject })
      this.post({ type: 1, invocationId: id, target, arguments: args })
    })
  }

  closed() {
    const was = this.connected
    this.connected = false
    clearInterval(this.timer)
    for (const c of this.calls.values()) c.reject(new Error('closed'))
    this.calls.clear()
    if (was) this.onstatus?.(false)
    setTimeout(() => this.connect(), this.delay)
    this.delay = Math.min(this.delay * 2 || 500, 10000)
  }
}
