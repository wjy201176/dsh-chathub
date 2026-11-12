// The Save control and the PDF export seam.
//
// The control is static HTML plus one static script, and the page's CSP admits
// that script by its sha256. The CLI runs are checked with a fake spawn, so the
// suite never starts a browser or touches the network.
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { exportReportPdf, injectSaveAction, SAVE_SCRIPT } from '../lib/report.js'
import { exportWithAm, printWithEdge, renderWithAm } from '../lib/am.js'
import { EdgeController } from '../lib/edge.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

const amPage = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-AAAA'; style-src 'unsafe-inline'; connect-src 'self'">
<title>Report</title></head>
<body>
<div class="am-toolbar" data-theme="auto"><button class="am-btn">Theme</button></div>
<main><p>body</p></main>
</body></html>`

console.log('-- the Save control --')
const injected = injectSaveAction(amPage, { key: 'k1', token: 't1' })
check('the button is in the page', injected.includes('am-chathub-save'))
check('the button sits inside the toolbar', injected.indexOf('am-chathub-save') > injected.indexOf('class="am-toolbar"') && injected.indexOf('am-chathub-save') < injected.indexOf('</div>', injected.indexOf('class="am-toolbar"')))
check('the button is the toolbar\'s last child', injected.indexOf('am-chathub-save') > injected.indexOf('data-am="copy"'))
check('the button is a label, not a script', injected.includes('>Save PDF</a>'))
check('the button points at the PDF route', injected.includes('/chathub/api/report/pdf?r=k1&amp;t=t1') || injected.includes('/chathub/api/report/pdf?r=k1&t=t1'))
check('the status line starts hidden', injected.includes('am-chathub-status') && injected.includes('hidden'))
check('the print rule hides the chrome', /@media print\{[^}]*\.am-toolbar/.test(injected))
check('the script is there', injected.includes(`<script data-chathub="save">`))
check('the script is the fixed one', injected.includes(SAVE_SCRIPT))

const hash = createHash('sha256').update(SAVE_SCRIPT, 'utf8').digest('base64')
check('the CSP admits the script by its hash', injected.includes(`'sha256-${hash}'`), hash)
check('the original script hash survives', injected.includes(`'sha256-AAAA'`))
check('adding it twice changes nothing', injectSaveAction(injected, { key: 'k1', token: 't1' }) === injected)

const plainPage = '<!doctype html><html><head><title>plain</title></head><body><p>plain</p></body></html>'
const plain = injectSaveAction(plainPage, { key: 'k2', token: 't2' })
check('a page without a toolbar gets a fixed wrapper', plain.includes('am-chathub-save-wrap'))
check('the button still works', plain.includes('/chathub/api/report/pdf?') && plain.includes('r=k2') && plain.includes('t=t2'))
check('a page without a CSP is left without one', !plain.includes('Content-Security-Policy'))
check('the wrapper goes before the body ends', plain.indexOf('am-chathub-save-wrap') < plain.indexOf('</body>'))

const encoded = injectSaveAction(plainPage, { key: 'a&b', token: 'c d' })
check('the key is URL-encoded', encoded.includes('r=a%26b') && encoded.includes('t=c%20d'))

console.log('\n-- running the CLI --')
const folder = mkdtempSync(join(tmpdir(), 'chathub-save-'))

function fakeSpawn(plan) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options }
    calls.push(call)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {
      child.killed = true
      setImmediate(() => child.emit('close', null))
    }
    child.stdin = { write() {}, end() {} }
    setImmediate(() => {
      const outcome = typeof plan === 'function' ? plan(call, calls.length) : plan
      if (outcome?.error !== undefined) {
        child.emit('error', Object.assign(new Error(outcome.error), { code: outcome.code ?? 'ENOENT' }))
        return
      }
      if (outcome?.create !== undefined) {
        try { writeFileSync(outcome.create, 'created') } catch { /* the assertion reports it */ }
      }
      if (outcome?.stdout !== undefined) child.stdout.write(outcome.stdout)
      if (outcome?.stderr !== undefined) child.stderr.write(outcome.stderr)
      if (outcome?.hang === true) return
      child.emit('close', outcome?.code ?? 0)
    })
    return child
  }
  return { spawnImpl, calls }
}

const cli = join(folder, 'am.mjs')
const page = join(folder, 'page.html')
const pdf = join(folder, 'out.pdf')
writeFileSync(page, '<html></html>')

const renderOut = join(folder, 'rendered.html')
const rendered = await renderWithAm({
  amCli: cli,
  draft: 'draft',
  outFile: renderOut,
  spawnImpl: fakeSpawn({ create: renderOut }).spawnImpl,
})
check('a successful render reports the page', rendered.ok === true && rendered.file === renderOut)

const renderCalls = fakeSpawn({ create: renderOut })
await renderWithAm({ amCli: cli, draft: 'draft', outFile: renderOut, spawnImpl: renderCalls.spawnImpl })
check('the CLI runs through node', renderCalls.calls[0].command === 'node')
check('the CLI path comes before the arguments', renderCalls.calls[0].args[0] === cli)
check('render reads stdin and writes the page', renderCalls.calls[0].args.slice(1).join(' ') === `render - -o ${renderOut} --no-open`)

const failing = fakeSpawn({ code: 3, stderr: 'first line\nanswer-me-with-html: bad draft' })
const failedRender = await renderWithAm({ amCli: cli, draft: 'draft', outFile: renderOut, spawnImpl: failing.spawnImpl })
check('a failed render reports the last error line', failedRender.ok === false && failedRender.error.includes('bad draft'), failedRender.error)

let attempt = 0
const fallbackNode = fakeSpawn((call) => {
  attempt += 1
  if (call.command === 'node') return { error: 'spawn node ENOENT', code: 'ENOENT' }
  return { create: renderOut }
})
const viaElectron = await renderWithAm({ amCli: cli, draft: 'draft', outFile: renderOut, spawnImpl: fallbackNode.spawnImpl })
check('a missing node is retried as Electron-in-Node-mode', fallbackNode.calls.length === 2 && fallbackNode.calls[1].options.env.ELECTRON_RUN_AS_NODE === '1')
check('the retry can still succeed', viaElectron.ok === true)

const hanging = fakeSpawn({ hang: true })
const timedOut = await renderWithAm({ amCli: cli, draft: 'draft', outFile: renderOut, timeoutMs: 25, spawnImpl: hanging.spawnImpl })
check('a hung CLI is killed and reported', timedOut.ok === false && timedOut.error.includes('timed out'), timedOut.error)

const exportPlan = fakeSpawn({ create: pdf })
const exported = await exportWithAm({ amCli: cli, pageFile: page, pdfFile: pdf, edgePath: 'C:\\Edge\\msedge.exe', spawnImpl: exportPlan.spawnImpl })
check('export reports the PDF', exported.ok === true && exported.file === pdf)
check('export passes the page and output', exportPlan.calls[0].args.slice(1).join(' ') === `export ${page} --pdf ${pdf}`)
check('export tells the CLI which browser to use', exportPlan.calls[0].options.env.AM_CHROME === 'C:\\Edge\\msedge.exe')

const edgePlan = fakeSpawn({ create: pdf })
const printed = await printWithEdge({ edgePath: 'C:\\Edge\\msedge.exe', pageFile: page, pdfFile: pdf, spawnImpl: edgePlan.spawnImpl })
check('the headless fallback prints the page', printed.ok === true)
check('the fallback runs headless', edgePlan.calls[0].args.includes('--headless=new'))
check('the fallback prints to the named file', edgePlan.calls[0].args.some((arg) => arg === `--print-to-pdf=${pdf}`))
check('the fallback loads the page over file://', edgePlan.calls[0].args.some((arg) => arg.startsWith('file:///')))
check('the fallback hides the page header', edgePlan.calls[0].args.includes('--no-pdf-header-footer'))

const noCli = fakeSpawn({ create: pdf })
const withoutCli = await exportReportPdf({ pageFile: page, pdfFile: pdf, amCli: null, edgePath: 'C:\\Edge\\msedge.exe', spawnImpl: noCli.spawnImpl })
check('without the CLI the Edge fallback still saves a PDF', withoutCli.ok === true && withoutCli.file === pdf)
check('a saved PDF is a real file', readFileSync(pdf).length > 0)

const broken = fakeSpawn({ code: 1, stderr: 'no browser found' })
const brokenExport = await exportReportPdf({ pageFile: page, pdfFile: pdf, amCli: null, edgePath: '', spawnImpl: broken.spawnImpl })
check('without any browser the save reports the error', brokenExport.ok === false && brokenExport.error !== '', brokenExport.error)

console.log('\n-- the controller-facing Save --')
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const controller = new EdgeController({ profileDir: join(folder, 'edge-profile'), edgePath: '', logger: quiet, windowWidth: 1680, windowHeight: 1000 })
const unknownSave = await controller.saveReportPdf('missing')
check('an unknown report is reported', unknownSave.ok === false && unknownSave.error === 'unknown-report', JSON.stringify(unknownSave))
const cachedFile = join(folder, 'cached.pdf')
writeFileSync(cachedFile, 'pdf')
controller.reports.set('cached', { html: '<html></html>', at: 0, save: true, tag: 'Topic', pageFile: null, pdf: { file: cachedFile, name: 'chatHub-topic-1.pdf' }, pending: null })
const cachedSave = await controller.saveReportPdf('cached')
check('a report saved before reuses its PDF', cachedSave.ok === true && cachedSave.value.name === 'chatHub-topic-1.pdf', JSON.stringify(cachedSave))
check('the data directory sits beside the Edge profile', controller.dataDir === folder, controller.dataDir)

console.log('\n-- the whole Save path, on disk --')
const fakeAm = join(folder, 'fake-am.mjs')
writeFileSync(fakeAm, [
  "import { writeFileSync } from 'node:fs'",
  'const args = process.argv.slice(2)',
  "if (args[0] === 'export') writeFileSync(args[3], '%PDF-1.4\\nfake pdf\\n')",
  '',
].join('\n'))
const wired = new EdgeController({
  profileDir: join(folder, 'wired-profile'),
  edgePath: '',
  amCli: fakeAm,
  pdfDir: join(folder, 'pdfs'),
  logger: quiet,
  windowWidth: 1680,
  windowHeight: 1000,
})
wired.reports.set('r1', { html: '<!doctype html><title>Report</title><p>body</p>', at: 0, save: true, tag: 'Wired test', pageFile: null, pdf: null, pending: null })
const wiredSave = await wired.saveReportPdf('r1')
check('Save writes the report page first', readFileSync(join(folder, 'wired-profile', '..', 'reports', 'r1.html'), 'utf8').includes('body'))
check('Save produces the PDF', wiredSave.ok === true && wiredSave.value.file.endsWith('.pdf'), JSON.stringify(wiredSave))
check('the PDF name carries the tag', String(wiredSave.value?.name ?? '').startsWith('chatHub-wired-test-'), String(wiredSave.value?.name))
check('the PDF lands in the configured folder', String(wiredSave.value?.file ?? '').includes(join('pdfs')), String(wiredSave.value?.file))
check('a second click reuses the same file', (await wired.saveReportPdf('r1')).value.file === wiredSave.value.file)

rmSync(folder, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
