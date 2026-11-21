// Minimal SignalR client (JSON hub protocol over a WebSocket, negotiation skipped).
// Covers what we use: invoke, server-to-client calls, keep-alive and reconnect.
const RS = '\x1e'

export class Hub {
  constructor(url) {
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

  on(name, fn) { this.handlers[name] = fn }

  connect() {
    const ws = this.ws = new WebSocket(this.url)
    let buf = ''
    ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS)
    ws.onmessage = e => {
      buf += e.data
      for (let i; (i = buf.indexOf(RS)) >= 0; buf = buf.slice(i + 1)) this.recv(JSON.parse(buf.slice(0, i)))
    }
    ws.onclose = () => this.closed()
  }

  recv(m) {
    this.last = Date.now()
    if (!this.connected) { // handshake response
      if (m.error) return this.ws.close()
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
    if (m.type === 1) this.handlers[m.target]?.(...m.arguments)
    else if (m.type === 3) {
      const c = this.calls.get(m.invocationId)
      this.calls.delete(m.invocationId)
      if (c) m.error ? c.reject(new Error(m.error)) : c.resolve(m.result)
    } else if (m.type === 7) this.ws.close()
  }

  post(m) { this.ws.send(JSON.stringify(m) + RS) }

  /** Fire-and-forget call. */
  send(target, ...args) {
    if (this.connected) this.post({ type: 1, target, arguments: args })
  }

  invoke(target, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('offline'))
      const id = String(++this.n)
      this.calls.set(id, { resolve, reject })
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
