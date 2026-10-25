/**
 * A very small Chrome DevTools Protocol client.
 *
 * chatHub drives the chatHub Edge window over the browser-level WebSocket:
 * four background tabs, one per provider, attached flat so every command can
 * carry its own `sessionId`.
 */

/** One browser-level DevTools connection. */
export class CdpClient {
  /**
   * @param {string} webSocketDebuggerUrl - browser endpoint from `/json/version`.
   * @param {{ timeoutMs?: number }} [options] - command timeout.
   */
  constructor(webSocketDebuggerUrl, options = {}) {
    this.url = webSocketDebuggerUrl
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.socket = null
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
  }

  /** Open the socket; resolves once the browser answers. */
  async connect() {
    if (typeof WebSocket !== 'function') throw new Error('WebSocket is unavailable in this runtime')
    const socket = new WebSocket(this.url)
    this.socket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('devtools connect timed out')), this.timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('devtools socket error'))
      }, { once: true })
    })
    socket.addEventListener('message', (event) => this.#onMessage(event))
    socket.addEventListener('close', () => {
      this.closed = true
      for (const [, waiter] of this.pending) waiter.reject(new Error('devtools connection closed'))
      this.pending.clear()
    })
    return this
  }

  #onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new Error(`${message.error.message ?? 'devtools error'}`))
      else waiter.resolve(message.result)
      return
    }
    if (message.method !== undefined) {
      for (const listener of this.listeners) {
        try {
          listener(message)
        } catch {
          /* a listener must not break the transport */
        }
      }
    }
  }

  /**
   * Send one command.
   * @param {string} method - CDP method name.
   * @param {object} [params] - method parameters.
   * @param {string} [sessionId] - flat session target.
   * @returns {Promise<any>} the method result.
   */
  send(method, params = {}, sessionId) {
    if (this.socket === null || this.closed) return Promise.reject(new Error('devtools connection closed'))
    const id = ++this.nextId
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify(payload))
    })
  }

  /** Subscribe to protocol events. */
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Close the socket without asking the browser to exit. */
  close() {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      /* already closed */
    }
    this.socket = null
  }
}

/**
 * Ask a freshly started Edge for its DevTools endpoint.
 * @param {number} port - the port passed to `--remote-debugging-port`.
 * @param {number} [attempts] - polling budget.
 * @returns {Promise<{ webSocketDebuggerUrl: string, Browser: string }>}
 */
export async function waitForDevTools(port, attempts = 80) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
      lastError = new Error(`devtools endpoint answered ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(150)
  }
  throw lastError ?? new Error('devtools endpoint never appeared')
}

/** Sleep helper. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
