// A column that goes full screen: the viewport the Host accepts, the shell
// wiring that asks for it, and the controller's resize call.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampViewport, jpegDimensions, EdgeController } from '../lib/edge.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

console.log('-- accepted viewports --')
check('a normal window size passes through', JSON.stringify(clampViewport(1680, 966)) === '{"width":1680,"height":966}')
check('fractions are rounded', clampViewport(800.6, 600.4).width === 801 && clampViewport(800.6, 600.4).height === 600)
check('the smallest edge is accepted', clampViewport(240, 240).width === 240)
check('the largest edge is accepted', clampViewport(4096, 4096).width === 4096)
check('numeric strings are accepted', clampViewport('1280', '720').width === 1280)

console.log('\n-- refused viewports --')
for (const [name, width, height] of [
  ['zero', 0, 600],
  ['negative', 800, -1],
  ['too narrow', 239, 600],
  ['too short', 800, 239],
  ['too wide', 4097, 600],
  ['too tall', 800, 4097],
  ['not a number', 'wide', 600],
  ['missing', undefined, undefined],
  ['infinite', Infinity, 600],
]) {
  check(`${name} is refused`, clampViewport(width, height) === null, JSON.stringify(clampViewport(width, height)))
}

console.log('\n-- the shell asks for it --')
const shell = readFileSync(new URL('../ui/shell.html', import.meta.url), 'utf8')
check('each column head has a full-screen button', shell.includes('fullScreen') && shell.includes("fullScreen.textContent = t('column.full')"))
check('clicking toggles the expanded column', shell.includes('toggleFullScreen') && shell.includes('collapseFullScreen'))
check('the layout hides the rail and composer while expanded', shell.includes('body[data-expanded="true"] #rail') && shell.includes('body[data-expanded="true"] #composer'))
check('only the expanded column stays visible', shell.includes('#grid[data-expanded="true"] .column[data-expanded="true"]'))
check('the host viewport route is called', shell.includes("api('viewport'"))
check('the restore size is the shared frame', shell.includes('void sendViewport(pane, FRAME_W, FRAME_H)'))
check('pointer mapping uses the reported viewport', shell.includes('pane.frameW || FRAME_W') && shell.includes('pane.frameH || FRAME_H'))
check('frames carry the viewport size', shell.includes("response.headers.get('x-frame-width')") && shell.includes("response.headers.get('x-frame-height')"))
check('only the expanded pane keeps streaming', shell.includes('state.expandedPane !== null && pane.id !== state.expandedPane'))
check('Esc leaves the full-screen view', shell.includes("event.key !== 'Escape'") && shell.includes('collapseFullScreen()'))

console.log('\n-- the frame size a resize can invalidate --')
// 1x1 white JPEG.
const onePixel = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64')
check('a JPEG size is read', JSON.stringify(jpegDimensions(onePixel)) === '{"width":1,"height":1}', JSON.stringify(jpegDimensions(onePixel)))
check('a non-JPEG has no size', jpegDimensions(Buffer.from('not a jpeg')) === null)
check('an empty buffer has no size', jpegDimensions(Buffer.alloc(0)) === null)

console.log('\n-- the controller resizes a pane --')
const folder = mkdtempSync(join(tmpdir(), 'chathub-viewport-'))
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const controller = new EdgeController({ profileDir: join(folder, 'edge-profile'), edgePath: '', logger: quiet, windowWidth: 1680, windowHeight: 1000, frameWidth: 520, frameHeight: 1180 })
const calls = []
controller.client = { send: async (method, params, sessionId) => { calls.push({ method, params, sessionId }); return {} } }
controller.child = { exitCode: null }
const pane = { provider: { id: 'chatgpt' }, targetId: 't', sessionId: 's', viewportWidth: 520, viewportHeight: 1180, frame: null, frameAt: 0, screencast: true }
controller.panes.set('chatgpt', pane)

const resized = await controller.setPaneViewport('chatgpt', 1600.4, 900.6)
check('the pane viewport is accepted and rounded', resized.ok === true && resized.value.width === 1600 && resized.value.height === 901, JSON.stringify(resized))
check('the emulation override is sent to that pane', calls.length === 1 && calls[0].method === 'Emulation.setDeviceMetricsOverride' && calls[0].params.width === 1600 && calls[0].params.height === 901 && calls[0].sessionId === 's', JSON.stringify(calls[0]))
check('the pane records its new viewport', pane.viewportWidth === 1600 && pane.viewportHeight === 901)
check('the stale frame is dropped', pane.frame === null)

const same = await controller.setPaneViewport('chatgpt', 1600, 901)
check('the same size does not re-emulate', same.ok === true && calls.length === 1)

const bad = await controller.setPaneViewport('chatgpt', 10, 10)
check('an invalid size is refused', bad.ok === false && bad.error === 'invalid-viewport')
const unknown = await controller.setPaneViewport('nope', 800, 600)
check('an unknown pane is refused', unknown.ok === false && unknown.error === 'unknown-pane')

pane.frame = { data: onePixel, etag: 'abc' }
const cached = await controller.frame('chatgpt')
check('a frame reports its viewport', cached.width === 1600 && cached.height === 901 && cached.etag === 'abc', JSON.stringify({ width: cached?.width, height: cached?.height }))

const stopped = new EdgeController({ profileDir: join(folder, 'stopped'), edgePath: '', logger: quiet })
const notRunning = await stopped.setPaneViewport('chatgpt', 800, 600)
check('a stopped Edge is reported', notRunning.ok === false && notRunning.error === 'not-running')

rmSync(folder, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
