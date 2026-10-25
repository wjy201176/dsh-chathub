/**
 * chatHub — Host half.
 *
 * Owns one Microsoft Edge instance that runs the chatHub window. The window's
 * page is served by this plugin; the model columns are background Edge
 * tabs driven over the DevTools protocol, so the user sees ChatGPT, Gemini,
 * Claude, DeepSeek and Grok side by side in one window and can type into any of them.
 */

import { EdgeController } from './lib/edge.js'
import { importEdgeCookies, describeImport } from './lib/cookies.js'
import { PROVIDERS } from './lib/providers.js'
import { renderDigestPage, renderHistoryPage, fallbackDigest } from './lib/summary.js'
import {
  fenceRefused,
  methodRefused,
  readBody,
  readJsonBody,
  sendJson,
  sendText,
} from './lib/http.js'

export const name = 'dsh-chathub'

/** Optional services: without a Web server the plugin has nothing to serve. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/chathub'
const UI_PATH = `${ROUTE_PREFIX}/ui`
const REPORT_PATH = `${ROUTE_PREFIX}/report`

const DEFAULTS = {
  windowWidth: 1680,
  windowHeight: 1000,
  frameQuality: 55,
  frameWidth: 520,
  frameHeight: 1180,
  frameInterval: 700,
  frameStaleMs: 2500,
  profileDir: '',
  edgePath: '',
  // Summarize: the report window's size, how long the model may take, and an
  // optional pinned `provider`/`model` route (empty = first available model).
  summaryWidth: 1280,
  summaryHeight: 900,
  summaryTimeoutMs: 120000,
  summaryProvider: '',
  summaryModel: '',
  // The summary is a comparison table, not an essay. A reasoning model with a
  // big budget can spend all of it thinking and emit no visible text at all.
  summaryMaxTokens: 4000,
  // History: how long to wait for the columns to finish answering before the
  // turn is stored, and how often to check.
  historyCaptureMs: 180000,
  historyPollMs: 3000,
}

function resolveConfig(config) {
  const merged = { ...DEFAULTS }
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (config[key] !== undefined) merged[key] = config[key]
    }
  }
  return merged
}

/**
 * Host plugin body.
 * @param ctx - Cordis root context.
 * @param config - row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const options = resolveConfig(config)
  const controller = new EdgeController({
    ...options,
    // An empty provider/model pair means "let the LLM service decide".
    summaryRoute: options.summaryProvider !== '' && options.summaryModel !== ''
      ? { provider: options.summaryProvider, model: options.summaryModel }
      : null,
    logger: ctx.logger,
  })

  const dispose = () => controller.dispose()

  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'chathub: edge lifetime')
  else ctx.on('dispose', dispose)

  const register = (webServer) => {
    if (webServer === null || typeof webServer !== 'object' || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('chathub: no webServer service, the chatHub window cannot be served')
      return
    }

    // Edge loads a real http URL, so the window target is the listener origin
    // rather than the GUI page's own (possibly custom-scheme) base. The port is
    // only known after the listener binds, so resolve it per launch.
    controller.setWindowUrlResolver(() => {
      const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : null
      if (typeof origin !== 'string' || origin === '') throw new Error('the web server has not bound a port yet')
      return `${origin}${UI_PATH}`
    })

    const routes = []
    const route = (kind, path, handler) => {
      routes.push(webServer.register({ kind, path, handler }))
    }

    route('exact', UI_PATH, (req, res) => {
      if (methodRefused(req, res, ['GET', 'HEAD'])) return
      if (fenceRefused(ctx, req, res, controller.windowToken)) return
      sendText(res, req.method === 'HEAD' ? '' : controller.renderUi(), {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
    })

    // The summary report window is a third browser profile, so it carries the
    // same per-launch token as the chatHub window and nothing else.
    route('exact', REPORT_PATH, (req, res) => {
      if (methodRefused(req, res, ['GET', 'HEAD'])) return
      if (fenceRefused(ctx, req, res, controller.windowToken)) return
      const reportKey = new URL(req.url ?? '/', 'http://local').searchParams.get('r') ?? ''
      sendText(res, req.method === 'HEAD' ? '' : controller.renderReport(reportKey), {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
    })

    route('prefix', `${ROUTE_PREFIX}/api`, async (req, res) => {
      if (fenceRefused(ctx, req, res, controller.windowToken)) return
      const path = new URL(req.url ?? '/', 'http://local').pathname.slice(`${ROUTE_PREFIX}/api`.length)
      try {
        await dispatch(path, req, res)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    })

    async function dispatch(path, req, res) {
      switch (path) {
        case '/state':
          if (methodRefused(req, res, ['GET', 'HEAD'])) return
          sendJson(res, 200, { ok: true, value: await controller.describe() })
          return
        case '/open':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.open())
          return
        case '/close':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.close())
          return
        case '/frame':
          if (methodRefused(req, res, ['GET'])) return
          await sendFrame(req, res)
          return
        case '/input':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.input(await readJsonBody(req)))
          return
        case '/prompt':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.prompt(await readJsonBody(req)))
          return
        case '/summarize':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await summarize(ctx, controller))
          return
        case '/session/new':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.newSession())
          return
        case '/history':
          if (methodRefused(req, res, ['GET', 'HEAD'])) return
          sendJson(res, 200, await controller.listHistory({ limit: Number(new URL(req.url ?? '/', 'http://local').searchParams.get('limit') ?? '') || undefined }))
          return
        case '/history/get':
          if (methodRefused(req, res, ['GET', 'HEAD'])) return
          sendJson(res, 200, await controller.getHistory(new URL(req.url ?? '/', 'http://local').searchParams.get('id') ?? ''))
          return
        case '/history/delete':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.deleteHistory((await readJsonBody(req))?.id ?? ''))
          return
        case '/history/open':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.loadHistory((await readJsonBody(req))?.id ?? ''))
          return
        case '/history/exit':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.exitHistory())
          return
        case '/history/view':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await openHistory(controller, (await readJsonBody(req))?.id ?? ''))
          return
        case '/attach':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.attach(await readBody(req), req.headers))
          return
        case '/reload':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.reload(await readJsonBody(req)))
          return
        case '/login':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.login(await readJsonBody(req)))
          return
        case '/cookies':
          if (methodRefused(req, res, ['POST'])) return
          sendJson(res, 200, await controller.importCookies())
          return
        case '/providers':
          if (methodRefused(req, res, ['GET', 'HEAD'])) return
          sendJson(res, 200, { ok: true, value: PROVIDERS.map(({ id, title, url }) => ({ id, title, url })) })
          return
        default:
          sendJson(res, 404, { ok: false, error: 'unknown route' })
      }
    }

    async function sendFrame(req, res) {
      const url = new URL(req.url ?? '/', 'http://local')
      const pane = url.searchParams.get('pane') ?? ''
      const etag = url.searchParams.get('etag') ?? req.headers['if-none-match'] ?? ''
      const frame = await controller.frame(pane)
      if (frame === null) {
        sendJson(res, 409, { ok: false, error: 'pane unavailable' })
        return
      }
      if (etag !== '' && etag === frame.etag) {
        res.writeHead(304, { etag: frame.etag, 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(frame.data.length),
        'cache-control': 'no-store',
        etag: frame.etag,
      })
      res.end(frame.data)
    }

    return () => {
      for (const off of routes.splice(0)) {
        try {
          off()
        } catch {
          /* route already gone */
        }
      }
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => register(scope.webServer ?? ctx.get('webServer')))
  } else {
    register(ctx.get('webServer'))
  }
}

/**
 * Summarize every column and open the report in its own Edge window.
 *
 * Two steps, and the second one is why this is a separate window rather than an
 * overlay in chatHub: the report is meant to be read (and compared) beside the
 * columns, not on top of them.
 * @param ctx - plugin context (reads the harness `llm` service).
 * @param controller - the Edge controller owning the panes.
 * @returns {Promise<object>} a result envelope for the shell.
 */
async function summarize(ctx, controller) {
  if (!controller.running) return { ok: false, error: 'not-running' }

  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { ok: false, error: 'the harness LLM service is unavailable' }
  }

  const { answers, failed, source } = await controller.collectAnswers()
  if (answers.length === 0) {
    return {
      ok: false,
      error: source === 'history'
        ? 'this chat has no stored answers to summarize'
        : 'no column has answered anything yet — send a prompt first',
    }
  }

  const prompt = controller.lastPrompt
  let result
  try {
    result = await controller.summarizeWith(llm, answers, prompt)
  } catch (error) {
    // Even an unexpected throw still produces a report: the columns' own words
    // are the comparison the reader came for.
    result = {
      digest: fallbackDigest(answers, String(error?.message ?? error)),
      model: 'none (captured answers)',
      degraded: true,
      reason: String(error?.message ?? error),
    }
  }

  const html = renderDigestPage({
    digest: result.digest,
    answers,
    prompt,
    createdAt: new Date().toLocaleString(),
    model: result.model,
    failed,
    degraded: result.degraded === true,
    reason: result.reason ?? '',
    source,
  })
  const opened = await controller.openReport(html)
  if (opened.ok !== true) return opened

  return {
    ok: true,
    value: {
      answers: answers.length,
      failed: failed.length,
      differences: result.digest.differences.length,
      consensus: result.digest.consensus.length,
      model: result.model,
      parsed: result.digest.parsed,
      degraded: result.degraded === true,
      reason: result.reason ?? '',
      source,
    },
  }
}

/**
 * Open one stored chat in its own Edge window.
 * @param controller - the Edge controller owning the browser.
 * @param id - the history entry id.
 * @returns {Promise<object>} a result envelope.
 */
async function openHistory(controller, id) {
  const entry = controller.history.get(String(id ?? ''))
  if (entry === null) return { ok: false, error: 'unknown-entry' }
  return controller.openReport(renderHistoryPage(entry))
}

/** Exported for the profile's settings UI and for tests. */
export { PROVIDERS, EdgeController, importEdgeCookies, describeImport }
