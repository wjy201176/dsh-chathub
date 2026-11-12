/**
 * Locate and run the `answer-me-with-html` CLI.
 *
 * chatHub uses the CLI in two places: it renders the summary report page, and
 * it exports that page to PDF through a headless Edge. Both are best-effort:
 * the report still opens (and still saves) when the CLI is missing.
 *
 * The CLI is a single-file ESM program that needs Node 20 for `render` and
 * Node 22 for `export` (the export driver uses the built-in WebSocket). The
 * Host runs inside Electron, so "node" may not be on PATH: every command is
 * tried with `node` first and then with the running Electron binary set to
 * Node mode (`ELECTRON_RUN_AS_NODE=1`).
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Where the CLI sits inside an installed `answer-me-with-html` package. */
export const AM_CLI_RELATIVE = join('node_modules', 'answer-me-with-html', 'skills', 'answer-me-with-html', 'scripts', 'am.mjs')

/** How much of a child's output is kept for an error message. */
const OUTPUT_LIMIT = 32 * 1024

/**
 * Find the CLI for the current profile.
 *
 * Candidates, in order: the configured override, the profile's own
 * node_modules, `$DSH_HOME/profiles/$DSH_PROFILE`, and finally any profile
 * that happens to have the package installed.
 * @param {{ override?: string, profileDir?: string, env?: NodeJS.ProcessEnv }} [options] - where to look.
 * @returns {string|null} the CLI path, or null when the package is not installed.
 */
export function resolveAmCli(options = {}) {
  const env = options.env ?? process.env
  const override = String(options.override ?? '').trim()
  const profileDir = String(options.profileDir ?? '').trim()
  const home = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const profile = String(env.DSH_PROFILE ?? '').trim()

  const candidates = []
  if (override !== '') candidates.push(override)
  if (profileDir !== '') candidates.push(join(profileDir, AM_CLI_RELATIVE))
  if (home !== '' && profile !== '') candidates.push(join(home, 'profiles', profile, AM_CLI_RELATIVE))
  if (home !== '') {
    try {
      for (const name of readdirSync(join(home, 'profiles'))) {
        candidates.push(join(home, 'profiles', name, AM_CLI_RELATIVE))
      }
    } catch {
      /* no profiles directory: the candidates above decide */
    }
  }

  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  return null
}

/** The commands that can run a Node program, in preference order. */
export function nodeCandidates(options = {}) {
  const execPath = options.execPath ?? process.execPath
  return [
    { command: 'node', args: [], extraEnv: {} },
    { command: execPath, args: [], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } },
  ]
}

/**
 * Run one child process and collect its output.
 *
 * Resolves for every outcome (spawn failure, timeout, non-zero exit), so the
 * caller always gets a result object instead of an exception.
 * @param {object} options - command, arguments, stdin, environment, timeout.
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnFailed: boolean, error: string}>}
 */
export function runProcess(options) {
  const {
    command,
    args = [],
    input = '',
    env = process.env,
    cwd,
    timeoutMs = 30_000,
    spawnImpl = spawn,
    extraEnv = {},
  } = options

  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: null, stdout, stderr, timedOut: true, spawnFailed: false, error: `timed out after ${timeoutMs} ms` })
    }, timeoutMs)

    try {
      child = spawnImpl(command, args, {
        cwd,
        env: { ...env, ...extraEnv },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, code: null, stdout, stderr, timedOut: false, spawnFailed: true, error: String(error?.message ?? error) })
      return
    }

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += String(chunk)
    })
    child.once('error', (error) => {
      finish({ ok: false, code: null, stdout, stderr, timedOut: false, spawnFailed: true, error: String(error?.message ?? error) })
    })
    child.once('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, timedOut: false, spawnFailed: false, error: code === 0 ? '' : `exit code ${String(code)}` })
    })

    try {
      if (input !== '') child.stdin?.write(input)
      child.stdin?.end()
    } catch {
      /* the child may already have gone */
    }
  })
}

/**
 * Run the CLI with the first Node command that exists.
 * @param {object} options - CLI path, arguments, stdin, timeout.
 * @returns {Promise<object>} the last attempt's result, with `node` recorded.
 */
export async function runWithNode(options) {
  const candidates = nodeCandidates(options)
  const { amCli, args = [], input = '', timeoutMs, env, cwd, spawnImpl } = options
  let last = null
  for (const candidate of candidates) {
    last = await runProcess({
      command: candidate.command,
      args: [...candidate.args, amCli, ...args],
      input,
      env,
      cwd,
      timeoutMs,
      spawnImpl,
      extraEnv: { ...(options.extraEnv ?? {}), ...candidate.extraEnv },
    })
    if (last.spawnFailed !== true) return { ...last, node: candidate.command }
  }
  return last
}

/**
 * Render one Markdown draft into an HTML page.
 * @param {object} options - `amCli`, `draft`, `outFile`, timeout and spawn seam.
 * @returns {Promise<{ok: boolean, file: string, error: string}>} the page path.
 */
export async function renderWithAm(options) {
  const { amCli, draft, outFile, timeoutMs = 30_000, spawnImpl, env, cwd } = options
  const result = await runWithNode({
    amCli,
    args: ['render', '-', '-o', outFile, '--no-open'],
    input: draft,
    env,
    cwd,
    timeoutMs,
    spawnImpl,
  })
  if (result.ok === true && existsSync(outFile)) return { ok: true, file: outFile, error: '' }
  const detail = tail(result.stderr !== '' ? result.stderr : result.error)
  return { ok: false, file: '', error: detail === '' ? 'answer-me-with-html render failed' : detail }
}

/**
 * Export a rendered page to PDF with the CLI's headless browser.
 * @param {object} options - `amCli`, `pageFile`, `pdfFile`, `edgePath`, timeout and spawn seam.
 * @returns {Promise<{ok: boolean, file: string, error: string}>} the PDF path.
 */
export async function exportWithAm(options) {
  const { amCli, pageFile, pdfFile, edgePath = '', timeoutMs = 60_000, spawnImpl, env, cwd } = options
  const extraEnv = edgePath === '' ? {} : { AM_CHROME: edgePath }
  const result = await runWithNode({
    amCli,
    args: ['export', pageFile, '--pdf', pdfFile],
    env,
    extraEnv,
    cwd,
    timeoutMs,
    spawnImpl,
  })
  if (result.ok === true && existsSync(pdfFile)) return { ok: true, file: pdfFile, error: '' }
  const detail = tail(result.stderr !== '' ? result.stderr : result.error)
  return { ok: false, file: '', error: detail === '' ? 'answer-me-with-html export failed' : detail }
}

/**
 * Print a page with a headless browser, without the CLI.
 *
 * This is the last-resort Save path: Chrome's `--print-to-pdf` applies print
 * media and keeps link annotations, but it does not print CSS backgrounds. It
 * exists so Save still produces a file when `answer-me-with-html` is absent.
 * @param {object} options - `edgePath`, `pageFile`, `pdfFile`, timeout and spawn seam.
 * @returns {Promise<{ok: boolean, file: string, error: string}>} the PDF path.
 */
export async function printWithEdge(options) {
  const { edgePath, pageFile, pdfFile, timeoutMs = 60_000, spawnImpl } = options
  if (!edgePath) return { ok: false, file: '', error: 'edge-missing' }
  const result = await runProcess({
    command: edgePath,
    args: [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfFile}`,
      pathToFileURL(pageFile).href,
    ],
    env: process.env,
    timeoutMs,
    spawnImpl,
  })
  if (result.ok === true && existsSync(pdfFile)) return { ok: true, file: pdfFile, error: '' }
  const detail = tail(result.stderr !== '' ? result.stderr : result.error)
  return { ok: false, file: '', error: detail === '' ? 'headless print failed' : detail }
}

/** The last non-empty line of a tool's output, for a one-line error. */
function tail(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.length === 0 ? '' : lines[lines.length - 1].slice(0, 400)
}
