/**
 * The summary report: turn a digest into a designed answer-me-with-html page,
 * add the Save-as-PDF control, and export that page to PDF.
 *
 * The page itself is produced by the answer-me-with-html CLI (`am render`), so
 * it carries that project's themes, dark mode and print rules. When the CLI is
 * unavailable the digest page from `summary.js` is used instead; both pages get
 * the same Save control and both can be exported.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { exportWithAm, printWithEdge, renderWithAm } from './am.js'
import { answeringTitles, renderDigestPage } from './summary.js'

/** Marks a page that already carries the Save control, so it is never added twice. */
const SAVE_MARKER = 'data-chathub="save"'

/**
 * The Save control's script. Fixed text on purpose: the page's Content-Security-
 * Policy admits it by the sha256 of exactly this string.
 */
export const SAVE_SCRIPT = `(()=>{
const button=document.querySelector('.am-chathub-save');
if(!button)return;
const status=document.querySelector('.am-chathub-status');
const show=(text,failed)=>{if(!status)return;status.hidden=false;status.textContent=text;status.classList.toggle('am-chathub-status--failed',failed===true)};
button.addEventListener('click',async(event)=>{
event.preventDefault();
if(button.getAttribute('aria-disabled')==='true')return;
button.setAttribute('aria-disabled','true');
show('Saving the PDF…',false);
try{
const target=new URL(button.href);
target.pathname=target.pathname.replace(/\\/pdf$/,'/save');
const response=await fetch(target.toString(),{method:'POST'});
const payload=await response.json().catch(()=>({ok:false,error:'invalid response'}));
if(payload&&payload.ok===true){show('Saved: '+payload.value.name,false);button.title=payload.value.file}
else{show('Save failed: '+String(payload&&payload.error||response.status),true)}
}catch(error){show('Save failed: '+String(error&&error.message||error),true)}
button.removeAttribute('aria-disabled');
});
})()`

/** The Save control's stylesheet, including the print rules that keep it out of the PDF. */
const SAVE_STYLE = `<style ${SAVE_MARKER}>
.am-chathub-save{font:12px/1 "Segoe UI",system-ui,sans-serif;color:var(--ink,#1c1d21);background:var(--paper,#fff);border:1px solid var(--line-2,#c9ced6);border-radius:8px;padding:7px 12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.am-chathub-save:hover{border-color:var(--ink-3,#8a94a3)}
.am-chathub-save[aria-disabled="true"]{opacity:.55;pointer-events:none}
.am-chathub-status{position:fixed;bottom:14px;inset-inline-end:14px;z-index:60;font:12px/1.4 "Segoe UI",system-ui,sans-serif;color:var(--ink,#1c1d21);background:var(--paper,#fff);border:1px solid var(--line-2,#c9ced6);border-radius:10px;padding:8px 12px;max-width:460px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.14)}
.am-chathub-status[hidden]{display:none}
.am-chathub-status--failed{color:var(--err,#b42318)}
.am-chathub-save-wrap{position:fixed;top:12px;right:12px;z-index:60;display:flex;gap:8px;align-items:center}
/* The report's theme and mode pickers are native <select>s. Windows paints the
   popup light, so a light inherited option colour would be invisible; pin both
   the option text and its background so a selected row always reads. */
select option{color:#111;background-color:#fff}
@media print{.am-toolbar,.am-chathub-save,.am-chathub-status,.am-chathub-save-wrap{display:none!important}}
</style>`

/**
 * Build the Markdown draft the CLI lays out.
 *
 * The shape follows the digest: an agreement callout, one row per model
 * position, the private conversation links, and a coverage table. Every value
 * that came from a model is treated as text: whitespace is collapsed, table
 * pipes and angle brackets are escaped, and long cells are clipped.
 * @param {object} input - digest plus the metadata the report shows.
 * @returns {string} an answer-me-with-html draft.
 */
export function buildReportDraft(input) {
  const digest = input?.digest ?? {}
  const answers = Array.isArray(input?.answers) ? input.answers : []
  const titles = answers.map((answer) => String(answer?.title ?? '')).filter((title) => title !== '')
  const links = input?.links !== null && typeof input?.links === 'object' ? input.links : {}
  const failed = Array.isArray(input?.failed) ? input.failed : []
  const degraded = input?.degraded === true
  const reason = cleanLine(input?.reason)
  const tag = cleanLine(input?.tag ?? digest?.tag)
  const prompt = cleanLine(input?.prompt)
  const createdAt = cleanLine(input?.createdAt)
  const model = cleanLine(input?.model)
  const source = input?.source === 'history' ? 'stored chat' : 'live columns'
  const answered = Array.isArray(input?.answered)
    ? new Set(input.answered.map((title) => String(title)))
    : new Set(answeringTitles(answers))

  const consensus = Array.isArray(digest?.consensus) ? digest.consensus : []
  const differences = Array.isArray(digest?.differences) ? digest.differences : []
  const notes = cleanLine(digest?.notes)

  const lines = []
  lines.push('---')
  lines.push('template: doc')
  lines.push('lang: en')
  lines.push(`title: ${frontmatter(tag === '' ? 'Model comparison' : tag)}`)
  if (prompt !== '') lines.push(`subtitle: ${frontmatter(clip(prompt, 110))}`)
  lines.push('file: chathub-summary')
  lines.push(`source: ${frontmatter([createdAt, degraded || model === '' ? 'captured answers' : `summarized by ${model}`, source].filter((part) => part !== '').join(' · '))}`)
  lines.push('---')
  lines.push('')

  lines.push('## Consensus')
  lines.push('')
  if (degraded) {
    lines.push('```callout warn No model summary')
    lines.push(reason === '' ? 'The model summary was not produced, so each column shows its captured answer.' : `The model summary was not produced (${clip(reason, 160)}), so each column shows its captured answer.`)
    lines.push('```')
    lines.push('')
  }
  if (consensus.length === 0) {
    lines.push('```callout info No shared position')
    lines.push('No point of agreement was identified.')
    lines.push('```')
  } else {
    lines.push('```callout ok Shared position')
    for (const item of consensus) lines.push(`- ${listText(item)}`)
    lines.push('```')
  }
  lines.push('')

  lines.push('## Where they differ')
  lines.push('')
  const rows = []
  for (const difference of differences) {
    const point = mdCell(difference?.point, 160)
    if (point === '') continue
    const cells = Array.isArray(difference?.cells) ? difference.cells : []
    for (const cell of cells) {
      const model2 = mdCell(cell?.model, 60)
      const view = mdCell(cell?.view, 320)
      if (model2 === '' || view === '') continue
      rows.push(`| ${point} | ${model2} | ${view} |`)
    }
  }
  if (rows.length === 0) {
    lines.push('No differences were identified.')
  } else {
    lines.push('| Point | Model | Position |')
    lines.push('| --- | --- | --- |')
    lines.push(...rows)
  }
  lines.push('')

  lines.push('## Original conversations')
  lines.push('')
  lines.push('Each link opens that model\'s own conversation in your account. These are private links, not published shares.')
  lines.push('')
  lines.push('| Model | Conversation |')
  lines.push('| --- | --- |')
  const linkTitles = titles.length > 0 ? titles : Object.keys(links)
  for (const title of linkTitles) {
    const link = httpsLink(links[title])
    const label = link === '' ? 'not saved' : `[Open ${mdCell(title, 40)} conversation](${link})`
    lines.push(`| ${mdCell(title, 60)} | ${label} |`)
  }
  lines.push('')

  lines.push('## Coverage')
  lines.push('')
  lines.push('| Model | Status | Note |')
  lines.push('| --- | --- | --- |')
  for (const title of linkTitles) {
    const failure = failed.find((entry) => String(entry?.title ?? '') === title)
    if (failure !== undefined) {
      lines.push(`| ${mdCell(title, 60)} | warn | capture failed: ${mdCell(failure.error, 120)} |`)
    } else if (answered.has(title)) {
      lines.push(`| ${mdCell(title, 60)} | ok | answered |`)
    } else {
      lines.push(`| ${mdCell(title, 60)} | no | not captured |`)
    }
  }
  if (notes !== '') {
    lines.push('')
    lines.push(`Note: ${mdCell(notes, 400)}`)
  }
  lines.push('')

  lines.push('## Report')
  lines.push('')
  lines.push('```kv cols=2')
  lines.push(`Created: ${kvText(createdAt)}`)
  lines.push(`Summarized by: ${kvText(degraded || model === '' ? 'captured answers' : model)}`)
  lines.push(`Source: ${kvText(source)}`)
  lines.push(`Topic: ${kvText(tag === '' ? 'not labelled' : tag)}`)
  lines.push('```')
  lines.push('')

  return lines.join('\n')
}

/**
 * Add the Save control to a complete HTML page.
 *
 * The control is an anchor that downloads the PDF route, plus a script that
 * turns the click into a POST so the page can report the saved file name. The
 * page's own CSP admits the script by its sha256; a page without a CSP needs no
 * change. Hostile or missing markup is left alone.
 * @param {string} html - the rendered report page.
 * @param {{ key: string, token: string }} params - this launch's report key and token.
 * @returns {string} the page with the Save control.
 */
export function injectSaveAction(html, params) {
  const source = String(html ?? '')
  if (source === '' || source.includes(SAVE_MARKER)) return source

  const href = saveActionUrl(params, 'pdf')
  const button = `<a class="am-btn am-chathub-save" ${SAVE_MARKER} href="${escapeAttribute(href)}" download="chathub-summary.pdf" title="Save this report as a PDF">Save PDF</a>`
  // The result line floats under the toolbar instead of sitting in it: the
  // toolbar is shrink-to-fit, so a long file name inside it would push the
  // button off the right edge.
  const toast = '<span class="am-chathub-status" role="status" aria-live="polite" hidden></span>'

  let page = source
  const toolbar = /<div class="am-toolbar"[^>]*>/.exec(page)
  if (toolbar !== null && typeof toolbar.index === 'number') {
    const openTagEnd = toolbar.index + toolbar[0].length
    const close = page.indexOf('</div>', openTagEnd)
    if (close !== -1) {
      // Last child of the toolbar: the top-right corner of the page.
      page = `${page.slice(0, close)}${button}${page.slice(close)}`
    } else {
      page = `${page.slice(0, openTagEnd)}${button}${page.slice(openTagEnd)}`
    }
  } else {
    page = page.replace('</body>', `<div class="am-chathub-save-wrap">${button}</div></body>`)
    if (!page.includes('am-chathub-save-wrap')) page = `${page}<div class="am-chathub-save-wrap">${button}</div>`
  }

  page = page.replace('</body>', `${SAVE_STYLE}${toast}<script ${SAVE_MARKER}>${SAVE_SCRIPT}</script></body>`)

  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(page)
  if (policy !== null) {
    const hash = `'sha256-${createHash('sha256').update(SAVE_SCRIPT, 'utf8').digest('base64')}'`
    if (!policy[1].includes(hash)) {
      const updated = policy[1].replace(/(^|;\s*)(script-src\s+)/, (_match, prefix, directive) => `${prefix}${directive}${hash} `)
      page = page.replace(policy[0], `<meta http-equiv="Content-Security-Policy" content="${updated}"`)
    }
  }

  return page
}

/**
 * Render the summary report for a digest.
 *
 * Tries the CLI first; any failure falls back to the plain digest page so the
 * user still gets a report. A rendered page is written under `<dataDir>/reports`
 * so it can be exported later even if the window is closed.
 * @param {object} input - the digest plus metadata (same shape as `renderDigestPage`).
 * @param {object} deps - data directory, summary id, CLI path, timeout, seams.
 * @returns {Promise<{html: string, pageFile: string|null, renderer: 'am'|'classic'}>}
 */
export async function renderSummaryReport(input, deps = {}) {
  const classic = { html: renderDigestPage(input), pageFile: null, renderer: 'classic' }
  const amCli = deps.amCli ?? null
  if (deps.renderer === 'classic' || amCli === null) return classic

  const draft = buildReportDraft(input)
  const summaryId = safeName(deps.summaryId ?? '', 'report')
  const outFile = join(deps.dataDir ?? '.', 'reports', `${summaryId}.html`)

  try {
    await mkdir(dirname(outFile), { recursive: true })
    const rendered = await renderWithAm({
      amCli,
      draft,
      outFile,
      timeoutMs: deps.timeoutMs ?? 30_000,
      spawnImpl: deps.spawnImpl,
      env: deps.env,
      cwd: deps.dataDir,
    })
    if (rendered.ok === true) {
      const html = await readFile(outFile, 'utf8')
      if (html.trim() !== '') {
        await pruneReports(dirname(outFile))
        return { html, pageFile: outFile, renderer: 'am' }
      }
    }
    deps.logger?.warn?.(`chathub: answer-me-with-html render failed (${rendered.error}); using the plain report`)
  } catch (error) {
    deps.logger?.warn?.(`chathub: answer-me-with-html render failed (${String(error?.message ?? error)}); using the plain report`)
  }
  return classic
}

/**
 * Export one report page to a PDF file.
 * @param {object} options - page file, output file, CLI and Edge paths, seams.
 * @returns {Promise<{ok: boolean, file: string, error: string}>} the saved PDF.
 */
export async function exportReportPdf(options) {
  const { pageFile, pdfFile, amCli = null, edgePath = '', timeoutMs = 60_000, spawnImpl, env, cwd } = options
  if (typeof pageFile !== 'string' || pageFile === '' || !existsSync(pageFile)) {
    return { ok: false, file: '', error: 'the report page is missing' }
  }
  try {
    await mkdir(dirname(pdfFile), { recursive: true })
  } catch (error) {
    return { ok: false, file: '', error: `cannot create the PDF folder: ${String(error?.message ?? error)}` }
  }

  let failure = ''
  if (amCli !== null && amCli !== '') {
    const exported = await exportWithAm({ amCli, pageFile, pdfFile, edgePath, timeoutMs, spawnImpl, env, cwd })
    if (exported.ok === true) return { ok: true, file: pdfFile, error: '' }
    failure = exported.error
  }
  const printed = await printWithEdge({ edgePath, pageFile, pdfFile, timeoutMs, spawnImpl })
  if (printed.ok === true) return { ok: true, file: pdfFile, error: '' }
  await rm(pdfFile, { force: true }).catch(() => {})
  return { ok: false, file: '', error: failure !== '' ? failure : printed.error }
}

/** The PDF file name the Save control produces. */
export function pdfFileName(tag, now = new Date()) {
  const slug = String(tag ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `chatHub-${slug === '' ? 'summary' : slug}-${stamp}.pdf`
}

/** Where saved PDFs go: the user's Downloads folder, else the plugin's own folder. */
export function pdfDirectory(dataDir, env = process.env) {
  const home = String(env.USERPROFILE ?? '').trim()
  if (home !== '') {
    const downloads = join(home, 'Downloads')
    if (existsSync(downloads)) return downloads
  }
  return join(dataDir, 'pdf')
}

/** The URL of one Save route for a report key. */
export function saveActionUrl(params, kind) {
  const key = encodeURIComponent(String(params?.key ?? ''))
  const token = encodeURIComponent(String(params?.token ?? ''))
  return `/chathub/api/report/${kind}?r=${key}&t=${token}`
}

/** Keep only the newest `keep` rendered pages. */
export async function pruneReports(folder, keep = 20) {
  try {
    const names = (await readdir(folder)).filter((name) => name.endsWith('.html'))
    if (names.length <= keep) return
    const dated = []
    for (const name of names) {
      try {
        dated.push({ name, mtime: (await stat(join(folder, name))).mtimeMs })
      } catch {
        /* a page that vanished is not our problem */
      }
    }
    dated.sort((a, b) => b.mtime - a.mtime)
    for (const entry of dated.slice(keep)) {
      await rm(join(folder, entry.name), { force: true }).catch(() => {})
    }
  } catch {
    /* pruning is best-effort */
  }
}

/** Collapse a value to one line and clip it, without escaping. */
function cleanLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function clip(text, limit) {
  const value = cleanLine(text)
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

/** A table cell: one line, pipes and angle brackets escaped, long text clipped. */
function mdCell(value, limit = 320) {
  return clip(value, limit)
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** A bullet item: one line, no markup that could break the list. */
function listText(value) {
  return cleanLine(value).replace(/^[-*+]\s+/, '')
}

/** A frontmatter value: one line, no leading/trailing quote that would unquote it. */
function frontmatter(value) {
  const text = cleanLine(value).replace(/^["']|["']$/g, '')
  return text === '' ? 'chatHub summary' : text
}

/** A key-value value: one line; colons inside the value are allowed. */
function kvText(value) {
  return cleanLine(value) === '' ? '—' : cleanLine(value)
}

/** Only an https conversation link becomes an anchor. */
function httpsLink(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') return ''
    return text.replace(/\)/g, '%29').replace(/\s+/g, '%20')
  } catch {
    return ''
  }
}

function safeName(value, fallback) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)
  return text === '' ? fallback : text
}

function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
