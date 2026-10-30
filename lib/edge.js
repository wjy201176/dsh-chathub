/**
 * Owns the chatHub Edge instance: process lifetime, the model tabs, live
 * frames, and input forwarding.
 *
 * The window's page is chatHub's own route; each column is an attached
 * background tab that chatHub screenshots on demand and types into over CDP.
 * That is what keeps every live provider session in one window: the tabs never
 * need to be focused by the user.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CdpClient, delay, waitForDevTools } from './cdp.js'
import { importEdgeCookies, seedProfile } from './cookies.js'
import { LIST_CONVERSATIONS_SCRIPT, OPEN_HISTORY_LIST_SCRIPT, answerAppearsInTranscript, rankCandidates } from './discover.js'
import { HistoryStore, historyPath, newAnswerText } from './history.js'
import { SummaryStore, summariesPath } from './summaries.js'
import { PROVIDERS, attachButtonScript, focusComposerScript, isProviderHost, loginButtonScript, probePaneScript } from './providers.js'
import { TRANSCRIPT_SCRIPT, clipAnswer, buildDigestPrompt, parseDigest, fallbackDigest, lowestReasoningEffort, looksLikeAnswer } from './summary.js'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

/** The chatHub shell page, read once from `ui/shell.html`. */
const SHELL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'shell.html')

/** Where the generated summary report is served (kept in step with index.js). */
const REPORT_PATH = '/chathub/report'
let shellCache = null

function shellHtml() {
  if (shellCache === null) {
    try {
      shellCache = readFileSync(SHELL_PATH, 'utf8')
    } catch (error) {
      shellCache = `<!doctype html><meta charset="utf-8"><title>chatHub</title><p>chatHub shell is missing: ${String(error?.message ?? error)}</p>`
    }
  }
  return shellCache
}

/**
 * Does this URL address one specific conversation?
 *
 * Every provider serves a chat at its own path (`/c/<id>`, `/chat/<id>`,
 * `/app/<id>`, `/a/chat/s/<id>`), and that is what makes native restore possible.
 * A bare home page carries no conversation, so storing it would make "open this
 * chat" land on a blank new-chat screen. The check is deliberately structural
 * rather than a list of per-provider patterns: those change, and a wrong guess
 * here is silently worse than falling back to the text view.
 * @param {string} href - the page URL captured with the transcript.
 * @returns {boolean} whether navigating there would restore a chat.
 */
export function isRestorableConversationUrl(href) {
  const value = String(href ?? '').trim()
  if (value === '') return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (!isProviderHost(url.hostname)) return false
  // One path segment is enough for a chat id; a bare "/" is a landing page.
  return url.pathname.split('/').filter((part) => part !== '').length >= 1
}

/**
 * Did the browser stay on the conversation we asked for?
 *
 * A provider can accept a navigation and then redirect to its landing page —
 * usually because the session expired. Comparing the path (not the full URL)
 * ignores query churn that providers add freely (`?rid=`, tracking params) while
 * still catching a redirect to `/` or `/app`.
 * @param {string} landed - where the browser actually is.
 * @param {string} wanted - the stored conversation URL.
 * @returns {boolean} whether the conversation path survived.
 */
export function sameConversation(landed, wanted) {
  const pathOf = (value) => {
    try {
      return new URL(String(value ?? '')).pathname.replace(/\/+$/, '')
    } catch {
      return ''
    }
  }
  const a = pathOf(landed)
  const b = pathOf(wanted)
  if (a === '' || b === '') return false
  if (a === b) return true
  // Some providers append a suffix (a message anchor, a tab id); the stored path
  // must still be the prefix of what we landed on.
  return a.startsWith(`${b}/`)
}

/** Locate Microsoft Edge. */
export function findEdge(configured) {
  for (const candidate of EDGE_CANDIDATES) if (existsSync(candidate)) return candidate
  return null
}

/** Ask the OS for a free loopback port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * Terminate an Edge instance that is still using chatHub's own profile
 * directory (for example one left over from a previous DSH run).
 *
 * The close is staged: a plain `taskkill` first, which asks the windows to
 * close so Chromium flushes its cookie database, and a force-kill only for the
 * processes that are still there afterwards. Force-killing a live chatHub
 * browser is exactly what loses the logins the user just made.
 * @param {string} profileDir - chatHub's Edge profile directory.
 * @param {object} logger - plugin logger.
 */
export async function killStaleInstance(profileDir, logger) {
  if (process.platform !== 'win32') return
  const needle = profileDir.toLowerCase().replace(/\//g, '\\')
  const listPids = [
    `$needle = '${needle.replace(/'/g, "''")}'`,
    'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) } |',
    '  Select-Object -ExpandProperty ProcessId',
  ].join('\n')
  const { execFile } = await import('node:child_process')
  const run = (script) =>
    new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 20_000 },
        (error, stdout) => resolve(error === null ? String(stdout) : ''),
      )
    })
  const pidsOf = (output) =>
    output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  try {
    const pids = pidsOf(await run(listPids))
    if (pids.length === 0) return

    // Ask politely first so Chromium can write its cookie database.
    for (const pid of pids) {
      await run(`try { taskkill /PID ${pid} | Out-Null } catch {}`)
    }
    await delay(3000)

    const remaining = pidsOf(await run(listPids))
    for (const pid of remaining) {
      await run(`try { Stop-Process -Id ${pid} -Force -ErrorAction Stop } catch {}`)
    }
    await delay(600)
    logger?.info?.(
      `chathub: closed ${pids.length} leftover chatHub Edge process(es)` +
        (remaining.length > 0 ? ` (${remaining.length} force-killed)` : ''),
    )
  } catch (error) {
    logger?.warn?.(`chathub: could not clear a leftover Edge instance: ${String(error?.message ?? error)}`)
  }
}

/**
 * Shut a browser down so its cookie database is flushed to disk.
 *
 * Chromium batches cookie writes, and the cookie database is only written out
 * during a clean shutdown: killing the process straight after `Browser.close`
 * reliably loses cookies set in that session (verified: a cookie written over
 * CDP survives a graceful exit and is absent after an immediate kill). Since the
 * whole point of chatHub's own profile is that the user stays signed in, this
 * waits for the process to actually exit, and only kills it as a last resort.
 * @param {CdpClient | null} client - the attached client, if any.
 * @param {import('node:child_process').ChildProcess | null} child - the process.
 */
async function shutdownBrowser(client, child) {
  if (child === null && client === null) return
  const alreadyGone = child === null || child.exitCode !== null
  const exited = alreadyGone
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        child.once('exit', () => resolve(true))
      })
  if (client !== null) {
    try {
      await Promise.race([client.send('Browser.close'), delay(2000)])
    } catch {
      /* the browser may already be gone */
    }
    client.close()
  }
  if (!alreadyGone) {
    const clean = await Promise.race([exited, delay(6000).then(() => false)])
    if (clean === false) {
      try {
        child.kill()
      } catch {
        /* already dead */
      }
    }
  }
  // Let Chromium finish writing its databases before the caller reads them.
  await delay(400)
}

/**
 * The chatHub Edge window and its provider tabs.
 */
export class EdgeController {
  /**
   * @param {object} options - resolved plugin config plus a logger.
   */
  constructor(options) {
    this.options = options
    this.logger = options.logger ?? console
    this.edgePath = findEdge(options.edgePath)
    this.profileDir = options.profileDir !== '' && options.profileDir !== undefined
      ? options.profileDir
      : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'chathub', 'edge-profile')
    this.child = null
    this.client = null
    this.port = null
    this.panes = new Map()
    this.windowTargetId = null
    this.starting = null
    this.lastError = null
    this.resolveWindowUrl = options.resolveWindowUrl ?? null
    this.pumpTimer = null
    this.pumping = false
    this.capturing = new Set()
    this.probedAt = 0
    /** The last prompt sent to the columns, quoted by the summary report. */
    this.lastPrompt = ''
    /**
     * The history entry currently on screen, or null for the live columns.
     *
     * This matters beyond bookkeeping: while a stored chat is displayed the
     * columns show captured text, not the live tabs, so anything that reads "what
     * the columns say" (Summarize) must read the same source the user is looking
     * at. Otherwise it summarizes a conversation that is no longer on screen.
     */
    this.viewingHistoryId = null
    /** Documents opened in their own windows, keyed by a per-launch id. */
    this.reports = new Map()
    // The history lives beside the Edge profile, in the plugin's own data dir,
    // so it survives both a DSH restart and a fresh Edge profile.
    this.history = new HistoryStore(
      historyPath(join(this.profileDir, '..')),
      this.logger,
    )
    // Saved summaries live beside the history: same data dir, same lifetime.
    this.summaries = new SummaryStore(
      summariesPath(join(this.profileDir, '..')),
      this.logger,
    )
    // The Edge window is its own browser profile, so it has no DSH session
    // cookie: the Host hands it a random per-launch token in its URL instead.
    this.windowToken = randomBytes(24).toString('base64url')
  }

  /** Where chatHub's own page lives; resolved lazily because the listener may
   *  not have bound its port when the plugin registers its routes. */
  setWindowUrlResolver(resolve) {
    this.resolveWindowUrl = resolve
  }

  #windowUrl() {
    try {
      const url = this.resolveWindowUrl?.()
      if (typeof url !== 'string' || url === '') return null
      const withToken = new URL(url)
      withToken.searchParams.set('t', this.windowToken)
      return withToken.href
    } catch (error) {
      this.logger.warn?.(`chathub: could not resolve the window URL: ${String(error?.message ?? error)}`)
      return null
    }
  }

  /** Is the Edge window currently alive? */
  get running() {
    return this.client !== null && this.child !== null && this.child.exitCode === null
  }

  /** The HTML shell served to the Edge window. */
  renderUi() {
    return shellHtml()
  }

  /** Public state for the client half. */
  async describe() {
    return {
      running: this.running,
      edgeFound: this.edgePath !== null,
      edgePath: this.edgePath,
      port: this.port,
      panes: PROVIDERS.map((provider) => {
        const pane = this.panes.get(provider.id)
        return {
          id: provider.id,
          title: provider.title,
          url: provider.url,
          targetId: pane?.targetId ?? null,
          ready: pane?.ready === true,
          loginRequired: pane?.status?.loginRequired === true,
          pageUrl: pane?.status?.href ?? null,
          pageTitle: pane?.status?.title ?? null,
        }
      }),
      error: this.lastError,
    }
  }

  /**
   * Start Edge (if needed), wait for DevTools, open the window and the panes.
   * @returns {Promise<object>} a result envelope.
   */
  async open() {
    if (this.running) return { ok: true, value: await this.describe() }
    if (this.starting !== null) return this.starting
    this.starting = this.#start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async #start() {
    this.lastError = null
    if (this.edgePath === null) {
      this.lastError = 'edge-missing'
      return { ok: false, error: 'edge-missing' }
    }
    const windowUrl = this.#windowUrl()
    if (windowUrl === null) {
      this.lastError = 'window-url-unknown'
      return { ok: false, error: 'window-url-unknown' }
    }
    await mkdir(this.profileDir, { recursive: true })

    // A chatHub Edge window can outlive a DSH restart. Chromium would then hand
    // the new launch to that running instance and never open the requested
    // debugging port, so clear any leftover instance of our own profile first.
    // This also has to happen before seeding, because seeding writes the
    // profile's cookie database and Chromium holds it open while running.
    await killStaleInstance(this.profileDir, this.logger)

    // Seed once, on first run, so the columns may start signed in. Afterwards
    // the profile belongs to the user: their logins and chat history live there.
    const seeded = await seedProfile(this.profileDir, isProviderHost)
    if (seeded) this.logger.info?.('chathub: seeded the chatHub Edge profile from the default Edge profile')

    this.port = await freePort()
    const args = [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${this.port}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${this.options.windowWidth},${this.options.windowHeight}`,
      `--app=${windowUrl}`,
    ]
    this.logger.info?.(`chathub: launching ${this.edgePath} on port ${this.port}`)
    try {
      this.child = spawn(this.edgePath, args, { detached: true, stdio: 'ignore' })
      this.child.unref()
      this.child.once('exit', () => {
        this.logger.info?.('chathub: the Edge window exited')
        this.#forget()
      })
    } catch (error) {
      this.lastError = `launch-failed: ${String(error?.message ?? error)}`
      return { ok: false, error: this.lastError }
    }

    try {
      const version = await waitForDevTools(this.port)
      this.client = await new CdpClient(version.webSocketDebuggerUrl).connect()
      this.client.onEvent((message) => {
        if (message.method === 'Page.screencastFrame') this.#onScreencastFrame(message)
      })
    } catch (error) {
      this.lastError = `devtools-unavailable: ${String(error?.message ?? error)}`
      await this.close()
      return { ok: false, error: this.lastError }
    }

    await this.#findWindow()
    await this.#openPanes()
    await this.#hideProviderWindow()
    return { ok: true, value: await this.describe() }
  }

  async #findWindow() {
    try {
      const { targetInfos } = await this.client.send('Target.getTargets')
      const window = targetInfos.find((info) => info.type === 'page' && String(info.url).includes('/chathub/ui'))
      this.windowTargetId = window?.targetId ?? null
    } catch (error) {
      this.logger.warn?.(`chathub: could not list targets: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Park the provider window out of sight.
   *
   * Chromium cannot put a new tab into an existing `--app` window: the provider
   * provider tabs always open in a second window. chatHub composites them from
   * screencast frames, so that window only has to exist, not be seen — moving it
   * far off-screen keeps the user looking at the single chatHub window while
   * frames keep flowing (a minimized window streams too, but off-screen leaves
   * the tab strip usable if the user ever wants to open it).
   */
  async #hideProviderWindow() {
    const first = [...this.panes.values()].find((pane) => pane.targetId !== null)
    if (first === undefined) return
    try {
      const { windowId } = await this.client.send('Browser.getWindowForTarget', { targetId: first.targetId })
      if (this.windowTargetId !== null) {
        const appWindow = await this.client.send('Browser.getWindowForTarget', { targetId: this.windowTargetId })
        if (appWindow.windowId === windowId) return
      }
      this.providerWindowId = windowId
      await this.client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: -32000, top: -32000, width: this.options.windowWidth, height: this.options.windowHeight, windowState: 'normal' },
      })
      this.logger.info?.('chathub: parked the provider window off-screen')
      await this.#raiseAppWindow()
    } catch (error) {
      this.logger.warn?.(`chathub: could not park the provider window: ${String(error?.message ?? error)}`)
    }
  }

  /** Bring the chatHub window to the front; creating the provider tabs leaves it behind. */
  async #raiseAppWindow() {
    if (this.windowTargetId === null) return
    try {
      await this.client.send('Target.activateTarget', { targetId: this.windowTargetId })
    } catch (error) {
      this.logger.warn?.(`chathub: could not focus the chatHub window: ${String(error?.message ?? error)}`)
    }
  }

  async #openPanes() {
    for (const provider of PROVIDERS) {
      const existing = this.panes.get(provider.id)
      if (existing !== undefined) continue
      try {
        const { targetId } = await this.client.send('Target.createTarget', {
          url: provider.url,
          background: true,
        })
        const { sessionId } = await this.client.send('Target.attachToTarget', { targetId, flatten: true })
        await this.client.send('Page.enable', {}, sessionId).catch(() => {})
        await this.client.send('Runtime.enable', {}, sessionId).catch(() => {})
        await this.client.send('Network.enable', {}, sessionId).catch(() => {})
        await this.client.send(
          'Emulation.setDeviceMetricsOverride',
          {
            width: this.options.frameWidth,
            height: this.options.frameHeight,
            deviceScaleFactor: 1,
            mobile: false,
          },
          sessionId,
        ).catch(() => {})
        await this.client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {})
        const pane = {
          provider,
          targetId,
          sessionId,
          ready: false,
          error: null,
          frame: null,
          frameAt: 0,
          screencast: false,
        }
        this.panes.set(provider.id, pane)
        await this.#startScreencast(pane)
      } catch (error) {
        this.panes.set(provider.id, {
          provider,
          targetId: null,
          sessionId: null,
          ready: false,
          error: String(error?.message ?? error),
          frame: null,
          frameAt: 0,
          screencast: false,
        })
      }
    }
    await delay(1500)
    await this.#probePanes()
    this.#startPump()
  }

  /**
   * Stream a pane's repaints instead of polling `Page.captureScreenshot`.
   *
   * Background tabs on heavy provider pages stall a screenshot for seconds —
   * sometimes past the command timeout — while the screencast pipeline keeps
   * delivering frames. Each frame is acknowledged so the next one is produced.
   */
  async #startScreencast(pane) {
    if (pane.sessionId === null) return
    try {
      await this.client.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: this.options.frameQuality,
          maxWidth: this.options.frameWidth,
          maxHeight: this.options.frameHeight,
          everyNthFrame: 1,
        },
        pane.sessionId,
      )
      pane.screencast = true
    } catch (error) {
      this.logger.warn?.(`chathub: screencast ${pane.provider.id} failed: ${String(error?.message ?? error)}`)
    }
  }

  async #probePanes() {
    for (const pane of this.panes.values()) {
      if (pane.sessionId === null) continue
      try {
        const result = await this.client.send(
          'Runtime.evaluate',
          {
            expression: probePaneScript(pane.provider.composer, pane.provider.loginHints, pane.provider.signedOutMarkers),
            returnByValue: true,
          },
          pane.sessionId,
        )
        pane.status = result?.result?.value ?? null
        pane.ready = pane.status?.ready === true
      } catch {
        pane.ready = false
      }
    }
  }

  /**
   * Drop all references to the browser.
   * @param {{ closeClient?: boolean }} [options] - leave the CDP socket open when
   *   the caller still needs it (a graceful shutdown sends `Browser.close`).
   */
  #forget(options = {}) {
    this.#stopPump()
    this.child = null
    if (options.closeClient !== false) this.client?.close()
    this.client = null
    this.port = null
    this.panes.clear()
    this.windowTargetId = null
  }

  /** Stop the Edge instance. */
  async close() {
    const client = this.client
    const child = this.child
    // Keep the CDP socket alive here: the graceful shutdown below needs it, and
    // closing it first turns the shutdown into a kill (which loses cookies).
    this.#forget({ closeClient: false })
    await shutdownBrowser(client, child)
    return { ok: true, value: await this.describe() }
  }

  /** Release everything on plugin unload. */
  async dispose() {
    const client = this.client
    const child = this.child
    this.#forget({ closeClient: false })
    await shutdownBrowser(client, child)
  }

  /**
   * One JPEG frame for a pane.
   *
   * Heavy provider pages make `Page.captureScreenshot` take up to a second on a
   * background tab, so frames are produced by a background pump that refreshes
   * every pane continuously and serves the newest cached frame. A request never
   * waits for a capture; it gets the current frame immediately.
   * @param {string} paneId - provider id.
   * @returns {Promise<{ data: Buffer, etag: string } | null>}
   */
  async frame(paneId) {
    if (!this.running) return null
    const pane = this.panes.get(paneId)
    if (pane === undefined || pane.sessionId === null) return null
    const cached = pane.frame
    if (cached !== null && cached !== undefined) return cached
    // No frame yet: capture once, synchronously, so the first paint is not blank.
    const shot = await this.#capture(pane)
    return shot
  }

  async #capture(pane) {
    if (pane.sessionId === null) return pane.frame ?? null
    if (this.capturing.has(pane.provider.id)) return pane.frame ?? null
    if (!this.running) return pane.frame ?? null
    this.capturing.add(pane.provider.id)
    try {
      const shot = await this.client.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: this.options.frameQuality, optimizeForSpeed: true },
        pane.sessionId,
      )
      if (typeof shot?.data !== 'string' || shot.data === '') return pane.frame ?? null
      this.#acceptFrame(pane, shot.data)
      return pane.frame
    } catch (error) {
      if (this.running) this.logger.warn?.(`chathub: frame ${pane.provider.id} failed: ${String(error?.message ?? error)}`)
      return pane.frame ?? null
    } finally {
      this.capturing.delete(pane.provider.id)
    }
  }

  /** Store one base64 JPEG as the pane's current frame. */
  #acceptFrame(pane, base64) {
    const data = Buffer.from(base64, 'base64')
    const etag = createHash('sha1').update(data).digest('hex').slice(0, 16)
    pane.frame = { data, etag }
    pane.frameAt = Date.now()
  }

  /** Handle one `Page.screencastFrame` event. */
  #onScreencastFrame(message) {
    const pane = [...this.panes.values()].find((candidate) => candidate.sessionId === message.sessionId)
    if (pane === undefined) return
    const { data, sessionId } = message.params
    this.#acceptFrame(pane, data)
    this.client.send('Page.screencastFrameAck', { sessionId }, message.sessionId).catch(() => {})
  }

  /**
   * Keep the cached frames fresh.
   *
   * Screencast delivers frames on its own; this pump only seeds panes that have
   * no frame yet (a fresh tab before its first repaint) and revives a screencast
   * that stopped delivering, so a quiet page still shows its current state.
   */
  #startPump() {
    if (this.pumpTimer !== null) return
    this.pumpTimer = setInterval(() => {
      void this.#pump()
    }, this.options.frameInterval)
    this.pumpTimer.unref?.()
  }

  async #pump() {
    if (this.pumping || !this.running) return
    this.pumping = true
    try {
      if (Date.now() - this.probedAt > 4000) {
        this.probedAt = Date.now()
        await this.#probePanes()
      }
      for (const pane of this.panes.values()) {
        if (pane.sessionId === null) continue
        const stale = pane.frame === null || Date.now() - pane.frameAt > this.options.frameStaleMs
        if (!stale) continue
        if (!pane.screencast) await this.#startScreencast(pane)
        if (pane.frame === null) await this.#capture(pane)
      }
    } finally {
      this.pumping = false
    }
  }

  #stopPump() {
    if (this.pumpTimer !== null) clearInterval(this.pumpTimer)
    this.pumpTimer = null
    this.pumping = false
    this.capturing.clear()
  }

  /**
   * Forward one raw input event from the shell page to a pane.
   * @param {object} payload - `{ pane, event }` where event is `key` | `text` | `mouse`.
   */
  async input(payload) {
    if (!this.running) return { ok: false, error: 'not-running' }
    const pane = this.panes.get(String(payload?.pane ?? ''))
    if (pane === undefined || pane.sessionId === null) return { ok: false, error: 'unknown-pane' }
    const event = payload?.event ?? {}
    try {
      if (event.kind === 'focus') {
        const focus = await this.client.send(
          'Runtime.evaluate',
          {
            expression: focusComposerScript(pane.provider.composer),
            returnByValue: true,
          },
          pane.sessionId,
        )
        return { ok: true, value: focus?.result?.value ?? null }
      }
      if (event.kind === 'text') {
        await this.client.send('Input.insertText', { text: String(event.text ?? '') }, pane.sessionId)
        return { ok: true }
      }
      if (event.kind === 'key') {
        await this.client.send(
          'Input.dispatchKeyEvent',
          {
            type: event.type ?? 'keyDown',
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.windowsVirtualKeyCode,
            nativeVirtualKeyCode: event.windowsVirtualKeyCode,
            text: event.text,
            unmodifiedText: event.text,
            modifiers: event.modifiers ?? 0,
          },
          pane.sessionId,
        )
        return { ok: true }
      }
      if (event.kind === 'mouse') {
        const type = event.type ?? 'mousePressed'
        await this.client.send(
          'Input.dispatchMouseEvent',
          {
            type,
            x: Number(event.x ?? 0),
            y: Number(event.y ?? 0),
            button: event.button ?? 'left',
            clickCount: event.clickCount ?? 1,
            deltaX: event.deltaX ?? 0,
            deltaY: event.deltaY ?? 0,
            modifiers: event.modifiers ?? 0,
          },
          pane.sessionId,
        )
        return { ok: true }
      }
      return { ok: false, error: 'unknown-event' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Reopen a stored chat in the columns, using each provider's own view.
   *
   * Every provider serves its conversations at an addressable URL (`/c/<id>`,
   * `/chat/<id>`, `/app/<id>`, `/a/chat/s/<id>`), and those are captured with the
   * answer. Navigating to them restores the model's REAL conversation — its own
   * formatting, code blocks, tables and images — so a history column looks and
   * behaves exactly like a live one. Re-rendering the captured text was the
   * earlier approach and is only a fallback now, for chats recorded before the
   * URLs were kept.
   *
   * No prompt is re-sent: this is a navigation, so it costs no quota.
   * @param {string} id - the history entry id.
   * @returns {Promise<object>} a result envelope.
   */
  async loadHistory(id) {
    const entry = this.history.get(String(id ?? ''))
    if (entry === null) return { ok: false, error: 'unknown-entry' }
    const turns = entry.turns ?? []
    if (turns.length === 0) return { ok: false, error: 'that chat has no recorded prompts' }

    // Every model that answered in any turn, in column order.
    const perModel = {}
    for (const provider of PROVIDERS) {
      const answers = []
      for (const turn of turns) {
        const text = turn.answers?.[provider.id]
        if (typeof text === 'string' && text.trim() !== '') {
          answers.push({ prompt: turn.prompt, at: turn.at, text })
        }
      }
      perModel[provider.id] = answers
    }

    // The latest recorded conversation URL per model: a later turn supersedes an
    // earlier one, because it addresses the whole conversation.
    const urls = {}
    for (const turn of turns) {
      for (const [model, href] of Object.entries(turn.urls ?? {})) {
        if (isRestorableConversationUrl(href)) urls[model] = href
      }
    }

    const navigated = {}
    const native = []
    const fallback = []

    // Recover missing URLs first, in parallel: each attempt navigates its own
    // column through candidate conversations, so the columns do not contend and
    // doing them together keeps the wait to roughly one provider's cost.
    const needsRecovery = PROVIDERS.filter((provider) => {
      const pane = this.panes.get(provider.id)
      return urls[provider.id] === undefined
        && pane !== undefined
        && pane.sessionId !== null
        && (perModel[provider.id] ?? []).length > 0
    })
    if (needsRecovery.length > 0) {
      const recovered = await Promise.all(
        needsRecovery.map(async (provider) => {
          const pane = this.panes.get(provider.id)
          const href = await this.#recoverConversationUrl(pane, perModel[provider.id], provider.title).catch(() => null)
          return { provider, href }
        }),
      )
      for (const { provider, href } of recovered) {
        if (href === null) continue
        urls[provider.id] = href
        navigated[provider.id] = { ok: true, url: href, recovered: true }
      }
      // Persist what was recovered so the next open is a plain navigation. A
      // recovered URL is already verified against the stored answer, so keeping
      // it is safe.
      const toRemember = Object.fromEntries(
        recovered.filter((entry) => entry.href !== null).map((entry) => [entry.provider.id, entry.href]),
      )
      if (Object.keys(toRemember).length > 0) this.history.rememberUrls(entry.id, toRemember)
    }

    for (const provider of PROVIDERS) {
      const pane = this.panes.get(provider.id)
      const href = urls[provider.id]

      if (href === undefined) {
        fallback.push(provider.id)
        if (navigated[provider.id] === undefined) navigated[provider.id] = { ok: false, error: 'no stored conversation URL' }
        continue
      }
      if (pane === undefined || pane.sessionId === null) {
        fallback.push(provider.id)
        navigated[provider.id] = { ok: false, error: 'column is not available' }
        continue
      }
      // A recovered column is already sitting on its conversation; re-navigating
      // would only reload it.
      if (navigated[provider.id]?.recovered === true) {
        native.push(provider.id)
        continue
      }
      try {
        await this.client.send('Page.navigate', { url: href }, pane.sessionId)
        native.push(provider.id)
        navigated[provider.id] = { ok: true, url: href }
      } catch (error) {
        fallback.push(provider.id)
        navigated[provider.id] = { ok: false, error: String(error?.message ?? error) }
      }
    }

    this.lastPrompt = turns[turns.length - 1].prompt ?? ''
    // Remember which chat is open so Summarize reads this record, not the tabs.
    this.viewingHistoryId = entry.id

    // Give the navigations a moment to render before the first screenshot.
    if (native.length > 0) {
      await delay(2500)
      await this.#probePanes()

      // Two things can quietly defeat a navigation, and both must fall back to
      // the captured text — showing a login form or a blank new-chat screen when
      // the user asked to read a chat is worse than the plain transcript:
      //
      // 1. a signed-out provider answers with its login page;
      // 2. a signed-out (or expired) provider silently redirects to its landing
      //    page, which looks like a working app but holds none of the history.
      for (const model of [...native]) {
        const pane = this.panes.get(model)
        const landed = String(pane?.status?.href ?? '')
        const wanted = urls[model] ?? ''
        let reason = ''
        if (pane?.status?.loginRequired === true) {
          reason = 'signed out, so the provider showed its login page'
        } else if (landed !== '' && !sameConversation(landed, wanted)) {
          reason = 'the provider redirected away from the conversation'
        }
        if (reason === '') continue
        native.splice(native.indexOf(model), 1)
        if (!fallback.includes(model)) fallback.push(model)
        navigated[model] = { ok: false, error: reason }
      }
    }

    return {
      ok: true,
      value: {
        id: entry.id,
        title: entry.title,
        turns: turns.length,
        // Columns showing their real provider conversation; their screenshots
        // are the native view and need no text overlay.
        native,
        // Columns rendering the captured text instead (no stored URL, or the
        // provider refused the navigation).
        fallback,
        navigated,
        models: Object.fromEntries(
          Object.entries(perModel).map(([id2, answers]) => [id2, answers.length]),
        ),
        transcripts: perModel,
        missing: Object.fromEntries(
          PROVIDERS.map((provider) => [
            provider.id,
            turns
              .filter((turn) => !String(turn.answers?.[provider.id] ?? '').trim())
              .map((turn) => turn.prompt),
          ]),
        ),
      },
    }
  }

  /**
   * Try to recover a conversation URL for a chat recorded before URLs were kept.
   *
   * The provider still holds the conversation and names it in its own history
   * list, so the prompt is matched against those titles, best candidate first.
   * A title match only proposes; the stored answer VERIFIES, because opening the
   * wrong conversation would silently replace what the user asked to see.
   *
   * Best-effort by design: any failure (no list, no match, not signed in) returns
   * null and the caller keeps the text fallback.
   * @param {object} pane - the column.
   * @param {Array<{ prompt: string, text: string }>} answers - this model's turns.
   * @param {string} title - the column title, for the error message only.
   * @returns {Promise<string | null>} a verified conversation URL, or null.
   */
  async #recoverConversationUrl(pane, answers, title) {
    const prompt = answers[0]?.prompt ?? ''
    const expected = answers[answers.length - 1]?.text ?? ''
    if (prompt === '' || expected === '') return null

    const evaluate = async (expression) => {
      const result = await this.client.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        pane.sessionId,
      )
      return result?.result?.value
    }

    // The list may be collapsed behind a toggle; harvesting and clicking cannot
    // share one script because the list renders as a result of the click. A
    // collapsed sidebar still yields a token anchor or two (the account link),
    // so a thin result is treated as "not open yet" rather than trusted.
    let candidates = await evaluate(LIST_CONVERSATIONS_SCRIPT).catch(() => null)
    if (!Array.isArray(candidates) || candidates.length < 3) {
      const opened = await evaluate(OPEN_HISTORY_LIST_SCRIPT).catch(() => null)
      if (opened !== null) {
        await delay(2500)
        const retried = await evaluate(LIST_CONVERSATIONS_SCRIPT).catch(() => null)
        if (Array.isArray(retried) && retried.length > (candidates?.length ?? 0)) candidates = retried
      }
    }
    if (!Array.isArray(candidates) || candidates.length === 0) return null

    const ranked = rankCandidates(prompt, candidates).filter((candidate) => candidate.score > 0)
    // Five attempts: a provider's own title can be a loose paraphrase, so the
    // right conversation is not always first — but each attempt costs a page
    // load, and the answer check decides, not the ranking. The whole search is
    // also given a deadline so a click can never hang on a provider that keeps
    // failing to settle.
    const deadline = Date.now() + this.options.recoverMs
    for (const candidate of ranked.slice(0, 5)) {
      if (Date.now() > deadline) break
      if (!isRestorableConversationUrl(candidate.href)) continue
      try {
        await this.client.send('Page.navigate', { url: candidate.href }, pane.sessionId)
        // A long conversation takes several seconds to render after navigation.
        // Reading too early sees a partial page and fails a match that would
        // succeed a moment later, so the transcript is polled until it settles.
        const text = await this.#readSettledTranscript(pane, Math.min(this.options.settleMs, deadline - Date.now()))
        if (text !== '' && answerAppearsInTranscript(expected, text)) return candidate.href
      } catch {
        /* try the next candidate */
      }
    }
    this.logger.warn?.(`chathub: could not match a stored conversation for ${title}`)
    // Every candidate was visited and rejected. Leaving the column on the last
    // one would strand the user on a conversation they never opened, so it goes
    // back to the provider's landing page.
    try {
      await this.client.send('Page.navigate', { url: pane.provider.url }, pane.sessionId)
    } catch {
      /* the caller falls back to text either way */
    }
    return null
  }

  /**
   * Read a pane's transcript once the page has finished rendering it.
   *
   * Polls until two consecutive reads are identical AND non-trivial, because a
   * conversation renders progressively: a single early read returns a partial
   * page, which makes a correct conversation look like the wrong one.
   * @param {object} pane - the column.
   * @returns {Promise<string>} the settled transcript, or '' when none appeared.
   */
  async #readSettledTranscript(pane, budget = this.options.settleMs) {
    let previous = ''
    const deadline = Date.now() + Math.max(3000, budget)
    while (Date.now() < deadline) {
      await delay(1200)
      const read = await this.readTranscript(pane).catch(() => ({ ok: false }))
      const text = read.ok === true ? read.text : ''
      if (text !== '' && text === previous) return text
      previous = text
    }
    return previous
  }

  /**
   * Type a prompt into every column and submit it.
   *
   * The transcripts are captured BEFORE and AFTER the send so the history can
   * record exactly what each model answered. `before` is read first, then the
   * prompt goes out, then the answers are collected once the columns have had
   * time to finish — this is what makes the History list able to show a past
   * turn at all, since the providers' own conversations cannot be re-opened.
   * @param {object} payload - `{ text, panes?: string[] }`.
   */
  async prompt(payload) {
    if (!this.running) return { ok: false, error: 'not-running' }
    const text = String(payload?.text ?? '')
    if (text.trim() === '') return { ok: false, error: 'empty-prompt' }
    // Remember it: the summary report quotes the prompt the columns answered.
    this.lastPrompt = text

    const before = new Map()
    for (const pane of this.panes.values()) {
      const read = await this.readTranscript(pane).catch(() => ({ ok: false }))
      if (read.ok === true) before.set(pane.provider.id, read.text)
    }

    const wanted = Array.isArray(payload?.panes) && payload.panes.length > 0
      ? new Set(payload.panes.map(String))
      : new Set(PROVIDERS.map((provider) => provider.id))
    const results = {}
    await Promise.all(
      [...this.panes.values()].map(async (pane) => {
        if (!wanted.has(pane.provider.id) || pane.sessionId === null) {
          results[pane.provider.id] = { ok: false, error: 'unavailable' }
          return
        }
        results[pane.provider.id] = await this.#submit(pane, text)
      }),
    )

    // Record the turn straight away so it appears in History even if the user
    // closes the window while the models are still answering.
    const session = this.history.current(text)
    const turn = this.history.addTurn(session.id, text)
    if (turn !== null) {
      this.#captureAnswers(before, session.id, turn.id, wanted).catch((error) => {
        this.logger.warn?.(`chathub: could not record the answer: ${String(error?.message ?? error)}`)
      })
    }

    return { ok: true, value: { results, session: session.id, turn: turn?.id ?? null } }
  }

  /**
   * Wait for the columns to finish, then store what each one answered.
   *
   * Polls rather than sleeping a fixed time: a fast model's answer is recorded
   * as soon as it is complete, and a slow one still gets recorded. The budget is
   * bounded so a hung column cannot keep this alive forever.
   * @param {Map<string, string>} before - transcripts captured before the send.
   * @param {string} sessionId - the history session.
   * @param {string} turnId - the history turn.
   * @param {Set<string>} wanted - provider ids this prompt went to.
   */
  async #captureAnswers(before, sessionId, turnId, wanted) {
    const answers = new Map()
    const urls = new Map()
    const missing = new Set()
    const deadline = Date.now() + this.options.historyCaptureMs
    const pending = new Set([...wanted].filter((id) => this.panes.get(id)?.sessionId !== null))

    while (pending.size > 0 && Date.now() < deadline) {
      await delay(this.options.historyPollMs)
      for (const id of [...pending]) {
        const pane = this.panes.get(id)
        if (pane === undefined) {
          pending.delete(id)
          missing.add(id)
          continue
        }
        const read = await this.readTranscript(pane).catch(() => ({ ok: false }))
        if (read.ok !== true) {
          pending.delete(id)
          missing.add(id)
          continue
        }
        const delta = newAnswerText(before.get(id) ?? '', read.text)
        // An answer is "in" once new text has appeared and stopped growing.
        if (delta !== '' && delta === answers.get(id)) {
          pending.delete(id)
        } else if (delta !== '') {
          answers.set(id, delta)
        }
        // The provider's own conversation URL is what lets history reopen this
        // chat natively instead of re-rendering captured text.
        if (isRestorableConversationUrl(read.href)) urls.set(id, read.href)
      }
    }
    for (const id of pending) missing.add(id)
    // The same echo test the summarizer uses: a column that only rendered the
    // prompt back has not answered, and must not be stored as if it had.
    this.history.completeTurn(
      sessionId,
      turnId,
      Object.fromEntries(answers),
      [...missing],
      (text) => looksLikeAnswer(text, this.history.get(sessionId)?.turns.find((turn) => turn.id === turnId)?.prompt ?? ''),
      Object.fromEntries(urls),
    )
  }

  /**
   * Start a fresh session: clear every column's conversation.
   *
   * Each provider is reset through its own "new chat" control when one is
   * advertised, and by navigating to its start page otherwise — navigating is
   * the reliable path, since the button's label and location differ per provider
   * and change without notice.
   * @returns {Promise<object>} a result envelope.
   */
  async newSession() {
    if (!this.running) return { ok: false, error: 'not-running' }
    const results = {}
    for (const pane of this.panes.values()) {
      if (pane.sessionId === null) {
        results[pane.provider.id] = { ok: false, error: 'unavailable' }
        continue
      }
      try {
        await this.client.send('Page.navigate', { url: pane.provider.url }, pane.sessionId)
        results[pane.provider.id] = { ok: true }
      } catch (error) {
        results[pane.provider.id] = { ok: false, error: String(error?.message ?? error) }
      }
    }
    this.lastPrompt = ''
    this.viewingHistoryId = null
    await delay(2500)
    await this.#probePanes()
    return { ok: true, value: { results } }
  }

  /**
   * The history, newest first.
   * @param {object} [payload] - `{ limit?: number }`.
   * @returns {Promise<object>} a result envelope.
   */
  async listHistory(payload) {
    const limit = Number.isInteger(payload?.limit) && payload.limit > 0 ? payload.limit : 100
    return { ok: true, value: { entries: this.history.list().slice(0, limit) } }
  }

  /**
   * One history entry.
   * @param {string} id - the session id.
   * @returns {Promise<object>} a result envelope.
   */
  async getHistory(id) {
    const entry = this.history.get(String(id ?? ''))
    if (entry === null) return { ok: false, error: 'unknown-entry' }
    return { ok: true, value: entry }
  }

  /**
   * Delete one history entry.
   * @param {string} id - the session id.
   * @returns {Promise<object>} a result envelope.
   */
  async deleteHistory(id) {
    return this.history.remove(String(id ?? ''))
      ? { ok: true, value: { deleted: true } }
      : { ok: false, error: 'unknown-entry' }
  }

  /**
   * The saved summaries, newest first, without their answer bodies.
   *
   * The timeline only needs the label, the date and a count, so the digest is
   * reduced here rather than shipping every table to the sidebar on each poll.
   * @param {object} [payload] - `{ limit?: number }`.
   * @returns {Promise<object>} a result envelope.
   */
  async listSummaries(payload) {
    const limit = Number.isInteger(payload?.limit) && payload.limit > 0 ? payload.limit : 100
    const entries = this.summaries.list().slice(0, limit).map((entry) => ({
      id: entry.id,
      title: entry.title,
      tag: typeof entry.tag === 'string' ? entry.tag : '',
      tagAuto: typeof entry.tagAuto === 'string' ? entry.tagAuto : '',
      tagEdited: entry.tagEdited === true,
      createdAt: entry.createdAt,
      model: entry.model,
      source: entry.source,
      degraded: entry.degraded,
      consensus: Array.isArray(entry.digest?.consensus) ? entry.digest.consensus.length : 0,
      differences: Array.isArray(entry.digest?.differences) ? entry.digest.differences.length : 0,
      models: Array.isArray(entry.titles) ? entry.titles.length : 0,
      links: entry.links !== null && typeof entry.links === 'object' ? Object.keys(entry.links).length : 0,
    }))
    return { ok: true, value: { entries } }
  }

  /**
   * One saved summary, complete.
   * @param {string} id - the summary id.
   * @returns {Promise<object>} a result envelope.
   */
  async getSummary(id) {
    const entry = this.summaries.get(String(id ?? ''))
    if (entry === null) return { ok: false, error: 'unknown-summary' }
    return { ok: true, value: entry }
  }

  /**
   * Delete one saved summary.
   * @param {string} id - the summary id.
   * @returns {Promise<object>} a result envelope.
   */
  async deleteSummary(id) {
    return this.summaries.remove(String(id ?? ''))
      ? { ok: true, value: { deleted: true } }
      : { ok: false, error: 'unknown-summary' }
  }

  /**
   * Overwrite the tag shown beside one saved summary.
   *
   * The tag is the user's own label for the row, so it is stored as typed
   * (cleaned to the chip's limits) and survives a restart with the record.
   * @param {object} payload - `{ id: string, tag: string }`.
   * @returns {Promise<object>} a result envelope with the stored tag.
   */
  async setSummaryTag(payload) {
    const entry = this.summaries.setTag(String(payload?.id ?? ''), payload?.tag)
    if (entry === null) return { ok: false, error: 'unknown-summary' }
    return { ok: true, value: { id: entry.id, tag: entry.tag, tagAuto: entry.tagAuto, tagEdited: entry.tagEdited } }
  }

  async #submit(pane, text) {
    try {
      const focus = await this.client.send(
        'Runtime.evaluate',
        { expression: focusComposerScript(pane.provider.composer), returnByValue: true },
        pane.sessionId,
      )
      const focused = focus?.result?.value ?? null
      if (focused?.ok !== true) return { ok: false, error: focused?.reason ?? 'composer-not-found' }
      await this.client.send('Input.insertText', { text }, pane.sessionId)
      await delay(120)
      await this.client.send(
        'Input.dispatchKeyEvent',
        {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r',
          unmodifiedText: '\r',
        },
        pane.sessionId,
      )
      await this.client.send(
        'Input.dispatchKeyEvent',
        {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        },
        pane.sessionId,
      )
      return { ok: true, selector: focused.selector }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Attach one file to every column's composer.
   *
   * Providers keep their `<input type=file>` out of the DOM until the user
   * presses the attach button, and that button opens the native file chooser.
   * chatHub therefore intercepts the chooser per pane (`Page.setInterceptFileChooserDialog`),
   * clicks the attach control, and hands the file to the intercepted dialog.
   * When a pane already has a live file input, that is used directly.
   * @param {Buffer} body - multipart or raw body.
   * @param {object} headers - request headers.
   */
  async attach(body, headers) {
    if (!this.running) return { ok: false, error: 'not-running' }
    const parsed = parseUpload(body, headers)
    if (parsed === null) return { ok: false, error: 'no-file' }
    const saved = await this.#saveAttachment(parsed)
    const results = {}
    await Promise.all(
      [...this.panes.values()].map(async (pane) => {
        if (pane.sessionId === null) {
          results[pane.provider.id] = { ok: false, error: 'unavailable' }
          return
        }
        results[pane.provider.id] = await this.#attachToPane(pane, saved)
      }),
    )
    return { ok: true, value: { name: parsed.name, results } }
  }

  async #attachToPane(pane, filePath) {
    // Fast path: a file input is already mounted.
    try {
      const { root } = await this.client.send('DOM.getDocument', { depth: 1 }, pane.sessionId)
      const { nodeId } = await this.client.send(
        'DOM.querySelector',
        { nodeId: root.nodeId, selector: 'input[type=file]' },
        pane.sessionId,
      )
      if (nodeId !== 0) {
        await this.client.send('DOM.setFileInputFiles', { nodeId, files: [filePath] }, pane.sessionId)
        return { ok: true, via: 'input' }
      }
    } catch {
      /* fall through to the chooser path */
    }

    // Intercept the native chooser, press the attach control, answer the dialog.
    try {
      await this.client.send('Page.enable', {}, pane.sessionId).catch(() => {})
      await this.client.send('Page.setInterceptFileChooserDialog', { enabled: true }, pane.sessionId)
      const opened = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000)
        const off = this.client.onEvent((message) => {
          if (message.sessionId !== pane.sessionId) return
          if (message.method !== 'Page.fileChooserOpened') return
          clearTimeout(timer)
          off()
          resolve(message.params)
        })
      })
      const found = await this.client.send(
        'Runtime.evaluate',
        { expression: attachButtonScript(pane.provider.attach), returnByValue: true },
        pane.sessionId,
      )
      const target = found?.result?.value ?? null
      if (target?.ok !== true) {
        await this.client.send('Page.setInterceptFileChooserDialog', { enabled: false }, pane.sessionId).catch(() => {})
        return { ok: false, error: 'no-attach-control' }
      }
      // A trusted click is required: a scripted click has no user activation, so
      // Chromium silently refuses to open the chooser.
      await this.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y }, pane.sessionId)
      await this.client.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 },
        pane.sessionId,
      )
      await this.client.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 },
        pane.sessionId,
      )
      const dialog = await opened
      await this.client.send('Page.setInterceptFileChooserDialog', { enabled: false }, pane.sessionId).catch(() => {})
      if (dialog === null) return { ok: false, error: 'chooser-not-opened' }
      if (dialog.backendNodeId !== undefined) {
        await this.client.send(
          'DOM.setFileInputFiles',
          { files: [filePath], backendNodeId: dialog.backendNodeId },
          pane.sessionId,
        )
        return { ok: true, via: 'chooser' }
      }
      return { ok: false, error: 'chooser-without-node' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async #saveAttachment(file) {
    const dir = join(this.profileDir, '..', 'attachments')
    await mkdir(dir, { recursive: true })
    const safe = file.name.replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'attachment'
    const target = join(dir, `${Date.now()}-${safe}`)
    await writeFile(target, file.data)
    return target
  }

  /**
   * Reload one pane or all of them.
   * @param {object} payload - `{ panes?: string[] }`.
   */
  async reload(payload) {
    if (!this.running) return { ok: false, error: 'not-running' }
    const wanted = Array.isArray(payload?.panes) && payload.panes.length > 0
      ? new Set(payload.panes.map(String))
      : new Set(PROVIDERS.map((provider) => provider.id))
    for (const pane of this.panes.values()) {
      if (!wanted.has(pane.provider.id) || pane.sessionId === null) continue
      await this.client.send('Page.reload', { ignoreCache: false }, pane.sessionId).catch(() => {})
    }
    await delay(1200)
    await this.#probePanes()
    return { ok: true, value: await this.describe() }
  }

  /**
   * Start a sign-in inside the pane itself, using the provider's preferred
   * method — for Claude that is "Continue with email", never the Apple account.
   *
   * Signing in inside the column is what makes the login stick: the cookies and
   * chat history land in chatHub's own Edge profile, which now survives restarts.
   * @param {object} payload - `{ pane }`.
   */
  async login(payload) {
    if (!this.running) return { ok: false, error: 'not-running' }
    const pane = this.panes.get(String(payload?.pane ?? ''))
    if (pane === undefined || pane.sessionId === null) return { ok: false, error: 'unknown-pane' }
    const target = pane.provider.login?.url ?? pane.provider.url
    try {
      await this.client.send('Page.navigate', { url: target }, pane.sessionId)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }

    // Let the login page settle, then press the preferred method if it is there.
    let clicked = null
    for (let attempt = 0; attempt < 12 && clicked === null; attempt += 1) {
      await delay(700)
      try {
        const found = await this.client.send(
          'Runtime.evaluate',
          { expression: loginButtonScript(pane.provider.login?.prefer ?? []), returnByValue: true },
          pane.sessionId,
        )
        const value = found?.result?.value
        if (value?.ok === true) {
          await this.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: value.x, y: value.y }, pane.sessionId)
          await this.client.send(
            'Input.dispatchMouseEvent',
            { type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 },
            pane.sessionId,
          )
          await this.client.send(
            'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 },
            pane.sessionId,
          )
          clicked = value.label ?? 'email'
        }
      } catch {
        /* keep waiting for the page to render */
      }
    }

    await delay(1200)
    await this.#probePanes()
    return {
      ok: true,
      value: {
        pane: pane.provider.id,
        url: target,
        method: clicked ?? 'default',
        // Tell the UI whether the email form is now on screen.
        awaitingInput: clicked !== null,
      },
    }
  }

  /**
   * Read one column's visible conversation.
   *
   * A signed-out column is refused rather than read: a login page has plenty of
   * text, and treating "Continue with Google / Continue with Apple" as an answer
   * produces confident differences no model ever said. The pane's own probe
   * already knows this, so it is asked first.
   * @param {object} pane - the pane record.
   * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>}
   */
  /**
   * Read one column's visible conversation.
   *
   * A signed-out column is refused rather than read: a login page has plenty of
   * text, and treating "Continue with Google / Continue with Apple" as an answer
   * produces confident differences no model ever said. The pane's own probe
   * already knows this, so it is asked first.
   * @param {object} pane - the pane record.
   * @returns {Promise<{ ok: true, text: string, href: string } | { ok: false, error: string }>}
   */
  async readTranscript(pane) {
    if (pane.sessionId === null) return { ok: false, error: 'column is not available' }
    try {
      const probe = await this.client.send(
        'Runtime.evaluate',
        {
          expression: probePaneScript(pane.provider.composer, pane.provider.loginHints, pane.provider.signedOutMarkers),
          returnByValue: true,
        },
        pane.sessionId,
      )
      const status = probe?.result?.value ?? null
      if (status?.loginRequired === true) return { ok: false, error: 'not signed in' }
      const result = await this.client.send(
        'Runtime.evaluate',
        { expression: TRANSCRIPT_SCRIPT, returnByValue: true, awaitPromise: true },
        pane.sessionId,
      )
      const value = result?.result?.value
      const text = String(value?.text ?? '').trim()
      if (text === '') return { ok: false, error: 'no conversation text on the page' }
      return { ok: true, text, href: String(value?.href ?? '') }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Stop showing a stored chat; the columns go back to the live tabs.
   * @returns {Promise<object>} a result envelope.
   */
  async exitHistory() {
    this.viewingHistoryId = null
    return { ok: true, value: { mode: 'live' } }
  }

  /**
   * Read what the columns are currently showing — history or live.
   *
   * This is the single source for anything that needs "what the columns say"
   * (Summarize). While a stored chat is open, the answers are read from that
   * record; otherwise the live tabs are read over CDP. Reading the live tabs
   * while history is on screen was the bug behind "No point of agreement": the
   * user was looking at stored answers while the summarizer was handed whatever
   * the tabs happened to be showing.
   *
   * A column that produced nothing usable is reported as failed rather than
   * passed on: a quota-exhausted column often still renders the echoed question,
   * and treating that as an answer invents a difference where the truth is "this
   * model said nothing".
   * @returns {Promise<{ answers: Array<{ title: string, text: string, truncated: boolean }>, failed: Array<{ title: string, error: string }>, source: 'history' | 'live' }>}
   */
  async collectAnswers() {
    const historyEntry = this.viewingHistoryId === null ? null : this.history.get(this.viewingHistoryId)
    if (historyEntry !== null && historyEntry !== undefined) {
      return this.#collectFromHistory(historyEntry)
    }

    const answers = []
    const failed = []
    const links = {}
    for (const provider of PROVIDERS) {
      const pane = this.panes.get(provider.id)
      const read = pane === undefined
        ? { ok: false, error: 'column is not available' }
        : await this.readTranscript(pane)
      if (read.ok !== true) {
        failed.push({ title: provider.title, error: read.error })
        continue
      }
      if (!looksLikeAnswer(read.text, this.lastPrompt)) {
        failed.push({ title: provider.title, error: 'no answer on the page (empty, still generating, or out of quota)' })
        continue
      }
      answers.push(clipAnswer(provider.title, read.text))
      // The column's own conversation URL, so the saved summary can link back to
      // the answer it summarized.
      if (isRestorableConversationUrl(read.href)) links[provider.title] = read.href
    }
    return { answers, failed, source: 'live', links }
  }

  /**
   * The answers of the stored chat currently on screen.
   *
   * Every turn of the chat is included, oldest first, labelled with the prompt
   * it answered — the summary is comparing a whole conversation, not one turn.
   *
   * The echo test is applied here too, not just on the live path: records
   * written before that check existed can hold a provider's rendered prompt
   * instead of a real answer (an out-of-quota column looks like that), and
   * summarizing it would report differences that no model ever expressed.
   * @param {object} entry - the history record.
   * @returns {{ answers: Array<object>, failed: Array<{ title: string, error: string }>, source: 'history' }}
   */
  #collectFromHistory(entry) {
    const answers = []
    const failed = []
    const links = {}
    for (const provider of PROVIDERS) {
      const parts = []
      let echoOnly = false
      for (const turn of entry.turns ?? []) {
        const text = turn.answers?.[provider.id]
        if (typeof text !== 'string' || text.trim() === '') continue
        if (!looksLikeAnswer(text, turn.prompt)) {
          echoOnly = true
          continue
        }
        parts.push(text.trim())
        // The newest recorded conversation URL for this model addresses the whole
        // conversation, so it is the one worth linking to.
        const href = turn.urls?.[provider.id]
        if (typeof href === 'string' && isRestorableConversationUrl(href)) links[provider.title] = href
      }
      if (parts.length === 0) {
        failed.push({
          title: provider.title,
          error: echoOnly ? 'only the echoed prompt was stored, not an answer' : 'no answer recorded for this chat',
        })
        continue
      }
      answers.push(clipAnswer(provider.title, parts.join('\n\n---\n\n')))
    }
    return { answers, failed, source: 'history', links }
  }

  /**
   * Ask the harness LLM to summarize the columns.
   *
   * A summary that fails must not take the report down with it. Three things go
   * wrong in practice, and each is handled rather than surfaced as an error:
   *
   * 1. the model spends its whole output budget on hidden reasoning and emits no
   *    visible text — fixed by pinning the lowest effort the model advertises;
   * 2. the chosen route is unavailable (quota, sign-in) — the next route is
   *    tried, so one dead provider does not disable the button;
   * 3. nothing works — a deterministic digest is built from the captured answers
   *    so the report still opens and still compares the columns.
   * @param {object} llm - the harness LLM service.
   * @param {Array<{ title: string, text: string }>} answers - one per column.
   * @param {string} prompt - the prompt the user sent.
   * @returns {Promise<{ digest: object, model: string, degraded: boolean, reason: string }>}
   */
  async summarizeWith(llm, answers, prompt) {
    const routes = await this.summarizeRoutes(llm)
    const { system, user } = buildDigestPrompt(answers, prompt)
    const problems = []

    for (const route of routes) {
      let result
      try {
        result = await this.#streamSummary(llm, route, system, user)
      } catch (error) {
        problems.push(`${route.provider}/${route.model}: ${String(error?.message ?? error)}`)
        continue
      }
      if (result.text === '') {
        problems.push(`${route.provider}/${route.model}: returned no text (finish=${result.finish})`)
        continue
      }
      const digest = parseDigest(result.text)
      return { digest, model: `${route.provider}/${route.model}`, degraded: digest.parsed !== true, reason: '' }
    }

    const reason = problems.length === 0 ? 'no model is available' : problems.join('; ')
    this.logger.warn?.(`chathub: summarize fell back to the captured answers — ${reason}`)
    return {
      digest: fallbackDigest(answers, reason),
      model: 'none (captured answers)',
      degraded: true,
      reason,
    }
  }

  /**
   * One streaming attempt against one route.
   *
   * The effort is pinned to the model's cheapest level: a reasoning model with
   * its default effort can consume the entire token budget before emitting a
   * single visible character, which is indistinguishable from a dead provider.
   * @param {object} llm - the harness LLM service.
   * @param {{ provider: string, model: string }} route - the route to use.
   * @param {string} system - the system prompt.
   * @param {string} user - the user prompt.
   * @returns {Promise<{ text: string, finish: string }>}
   */
  async #streamSummary(llm, route, system, user) {
    let effort
    if (typeof llm.resolveModelInfo === 'function') {
      try {
        const info = await Promise.resolve(llm.resolveModelInfo(route.provider, route.model)).catch(() => undefined)
        effort = lowestReasoningEffort(info?.reasoning?.efforts)
      } catch {
        effort = undefined
      }
    }

    let text = ''
    let finish = 'unknown'
    let failure = null
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: user }],
            source: { kind: 'plugin:dsh-chathub' },
          },
        ],
        maxTokens: this.options.summaryMaxTokens,
        signal: AbortSignal.timeout(this.options.summaryTimeoutMs),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && text === '') {
          text = chunk.block.text
        } else if (chunk?.type === 'finish') {
          finish = String(chunk.reason?.kind ?? 'unknown')
          if (chunk.reason?.kind === 'error') failure = String(chunk.reason.failure?.message ?? 'the summarizer failed')
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // A partial answer is still usable: better a truncated summary than none.
        if (text.trim() === '') throw new Error('timed out with no text')
      } else {
        throw error
      }
    }
    if (failure !== null && text.trim() === '') throw new Error(failure)
    return { text: text.trim(), finish }
  }

  /**
   * Every route worth trying, in order: the configured one, then the session's
   * own model, then each provider's first model.
   *
   * Trying more than one is what keeps the button working when a single provider
   * is rate-limited — the exact case that produced "returned nothing".
   * @param {object} llm - the harness LLM service.
   * @returns {Promise<Array<{ provider: string, model: string }>>}
   */
  async summarizeRoutes(llm) {
    const routes = []
    const seen = new Set()
    const add = (provider, model) => {
      const key = `${provider}/${model}`
      if (provider === '' || model === '' || seen.has(key)) return
      seen.add(key)
      routes.push({ provider, model })
    }

    const configured = this.options.summaryRoute
    if (configured !== null && configured !== undefined) add(configured.provider, configured.model)

    const preferred = this.options.summaryProvider !== '' && this.options.summaryModel !== ''
      ? { provider: this.options.summaryProvider, model: this.options.summaryModel }
      : null
    if (preferred !== null) add(preferred.provider, preferred.model)

    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    for (const entry of providers) {
      const provider = String(entry?.id ?? entry?.provider ?? '')
      if (provider === '') continue
      try {
        const models = await llm.listModels(provider)
        for (const model of (models ?? []).slice(0, 2)) {
          add(provider, String(model?.id ?? ''))
        }
      } catch {
        // A provider whose catalog cannot be read is simply not a candidate.
      }
    }
    return routes
  }

  /**
   * Open a generated document (summary report or stored chat) in its own Edge
   * window.
   *
   * The document is served by this plugin's own route rather than passed as a
   * `data:` URL: a wide table easily exceeds what a command line can carry, and
   * the main chatHub window already proves that an http route works for an Edge
   * `--app` window. Each launch gets its own key so two open windows never show
   * each other's content.
   * @param {string} html - a complete HTML document.
   * @returns {Promise<object>} a result envelope.
   */
  async openReport(html) {
    if (this.edgePath === null) return { ok: false, error: 'edge-missing' }
    const key = randomBytes(9).toString('base64url')
    this.reports.set(key, { html, at: Date.now() })
    // Keep only the last few documents; each window is independent, but there is
    // no reason to hold every report ever generated.
    while (this.reports.size > 12) {
      const oldest = [...this.reports.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest === undefined) break
      this.reports.delete(oldest[0])
    }
    let url
    try {
      const base = this.resolveWindowUrl?.()
      if (typeof base !== 'string' || base === '') throw new Error('the web server has not bound a port yet')
      const reportUrl = new URL(base)
      reportUrl.pathname = `${REPORT_PATH}`
      reportUrl.search = ''
      reportUrl.searchParams.set('t', this.windowToken)
      reportUrl.searchParams.set('r', key)
      url = reportUrl.href
    } catch (error) {
      return { ok: false, error: `report-url-unknown: ${String(error?.message ?? error)}` }
    }
    try {
      // Open the report as a NEW WINDOW of the running chatHub browser rather
      // than launching Edge again.
      //
      // The window must live in chatHub's own profile: the per-model links in the
      // report are the user's private conversation URLs, and a separate profile
      // has none of the provider cookies, so every link there landed on a sign-in
      // page or a fresh chat. Driving it over CDP also avoids depending on how a
      // second launch is handed off to the running instance.
      const created = await this.client.send('Target.createTarget', {
        url,
        newWindow: true,
        background: false,
        width: this.options.summaryWidth,
        height: this.options.summaryHeight,
      })
      // Chromium gives a new window the position of the window it was opened
      // from, and chatHub's provider window is parked off-screen — so the report
      // would open where the user cannot see it. Place it on the primary screen.
      const targetId = created?.targetId ?? null
      if (targetId !== null) {
        try {
          const { windowId } = await this.client.send('Browser.getWindowForTarget', { targetId })
          await this.client.send('Browser.setWindowBounds', {
            windowId,
            bounds: { left: 120, top: 80, width: this.options.summaryWidth, height: this.options.summaryHeight, windowState: 'normal' },
          })
        } catch (error) {
          this.logger.warn?.(`chathub: could not place the report window: ${String(error?.message ?? error)}`)
        }
      }
      return { ok: true, value: { window: 'summary', targetId } }
    } catch (error) {
      return { ok: false, error: `report-launch-failed: ${String(error?.message ?? error)}` }
    }
  }

  /**
   * The document a report window asked for.
   * @param {string} key - the `r` parameter of that window's URL.
   * @returns {string} the HTML, or a short explanation when it is gone.
   */
  renderReport(key) {
    const report = this.reports.get(String(key ?? ''))
    if (report !== undefined) return report.html
    return '<!doctype html><meta charset="utf-8"><title>chatHub</title><p style="font:14px system-ui;padding:24px">This document is no longer available. Open it again from chatHub.</p>'
  }

  /**
   * Import the user's Edge cookies into the running instance.
   */
  async importCookies() {
    if (!this.running) return { ok: false, error: 'not-running' }
    let result
    try {
      result = await importEdgeCookies(join(this.profileDir, 'Default'), isProviderHost)
    } catch (error) {
      const message = String(error?.message ?? error)
      const locked = /EBUSY|EPERM|locked|used by another process/i.test(message)
      return { ok: false, error: locked ? 'cookies-locked' : `cookies-failed: ${message}` }
    }
    if (result.cookies.length === 0) return { ok: false, error: 'cookies-empty' }
    let applied = 0
    const failures = []
    for (const pane of this.panes.values()) {
      if (pane.sessionId === null) continue
      for (const cookie of result.cookies) {
        try {
          await this.client.send(
            'Network.setCookie',
            {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.host,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              expires: cookie.expires > 0 ? cookie.expires : undefined,
            },
            pane.sessionId,
          )
          applied += 1
        } catch (error) {
          failures.push(String(error?.message ?? error))
        }
      }
    }
    await this.reload({})
    return {
      ok: true,
      value: {
        cookies: result.cookies.length,
        applied,
        failures: failures.length,
        sourceProfile: result.sourceProfile,
      },
    }
  }
}

/**
 * Pull one uploaded file out of a multipart body (or accept a raw body).
 * @returns {{ name: string, data: Buffer } | null}
 */
export function parseUpload(body, headers) {
  const contentType = String(headers?.['content-type'] ?? '')
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (contentType.startsWith('multipart/form-data') && boundaryMatch !== null) {
    const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`)
    const parts = splitBuffer(body, boundary)
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n')
      if (headerEnd === -1) continue
      const headerText = part.subarray(0, headerEnd).toString('utf8')
      if (!/name="file"/i.test(headerText)) continue
      const nameMatch = /filename="([^"]*)"/i.exec(headerText)
      const data = part.subarray(headerEnd + 4, Math.max(headerEnd + 4, part.length - 2))
      return { name: nameMatch?.[1] ?? 'attachment', data }
    }
    return null
  }
  const name = String(headers?.['x-file-name'] ?? 'attachment')
  return body.length === 0 ? null : { name, data: body }
}

function splitBuffer(buffer, separator) {
  const parts = []
  let index = buffer.indexOf(separator)
  while (index !== -1) {
    const next = buffer.indexOf(separator, index + separator.length)
    if (next === -1) break
    parts.push(buffer.subarray(index + separator.length + 2, next))
    index = next
  }
  return parts
}

/** Remove a previously seeded profile (used by tests and a future reset action). */
export async function resetProfile(profileDir) {
  await rm(profileDir, { recursive: true, force: true })
}

/** Read the shell page from disk when it is available (dev convenience). */
export function readShell() {
  return shellHtml()
}
