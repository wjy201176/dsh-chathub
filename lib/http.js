/** Small HTTP helpers shared by the chatHub routes. */

import { timingSafeEqual } from 'node:crypto'

/**
 * Authorize one request to a chatHub route.
 *
 * Two callers reach these routes and they authenticate differently:
 *
 * - the DSH GUI page, which carries DSH's own session cookie and passes the
 *   connection fence like any shipped plugin route;
 * - the chatHub Edge window, which is a SEPARATE browser profile with no DSH
 *   session cookie at all. It authenticates with the random per-launch token
 *   embedded in the URL the Host itself opened, so the fence must not demand a
 *   cookie it can never have.
 *
 * A token request still has to come from loopback and address a loopback
 * authority; it only skips the cookie and origin checks.
 * @param ctx - plugin context (reads an optional `connection` service).
 * @param req - node request.
 * @param res - node response, written when the request is refused.
 * @param token - the current window token, or null while none is issued.
 * @returns true when the caller must stop handling the request.
 */
export function fenceRefused(ctx, req, res, token) {
  if (hasWindowToken(req, token)) {
    if (!isLoopbackPeer(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    if (!isLoopbackAuthority(req.headers.host)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    return false
  }

  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (typeof connection?.requestRejection === 'function') {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      return true
    }
  }
  if (!isLoopbackPeer(req.socket?.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return true
  }
  const host = req.headers.host
  if (host !== undefined && !isLoopbackAuthority(host)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return true
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return true
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    if (!URL.canParse(origin)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    if (new URL(origin).host !== host) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
  }
  return false
}

/**
 * Does this request carry the window token?
 * Accepted from the `x-chathub-token` header or the `t` query parameter, and
 * compared in constant time.
 * @param req - node request.
 * @param token - the current window token.
 */
export function hasWindowToken(req, token) {
  if (typeof token !== 'string' || token === '') return false
  const header = req.headers['x-chathub-token']
  const supplied = typeof header === 'string' && header !== ''
    ? header
    : new URL(req.url ?? '/', 'http://local').searchParams.get('t') ?? ''
  if (supplied === '' || supplied.length !== token.length) return false
  try {
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  } catch {
    return false
  }
}

function isLoopbackPeer(address) {
  if (address === undefined) return false
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain)
}

function isLoopbackAuthority(host) {
  if (!URL.canParse(`http://${host}`)) return false
  const name = new URL(`http://${host}`).hostname
  return name === 'localhost' || name === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/**
 * Answer with 405 unless the request uses one of the accepted methods.
 * @returns true when the response was already written.
 */
export function methodRefused(req, res, methods) {
  if (req.method !== undefined && methods.includes(req.method)) return false
  res.writeHead(405, { allow: methods.join(', ') })
  res.end()
  return true
}

/** Write a JSON response. */
export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Write a text response. */
export function sendText(res, text, headers) {
  const body = Buffer.from(text)
  res.writeHead(200, { ...headers, 'content-length': String(body.length) })
  res.end(body)
}

/** Collect a request body up to `limit` bytes. */
export function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Collect and parse a JSON request body, tolerating an empty body. */
export async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}
