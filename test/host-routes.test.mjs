// Boot the real Host plugin against a stub cordis context and exercise the
// /summaries routes â€” including /summaries/tag â€” over a real socket.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'chathub-host-'))
process.env.DSH_HOME = home

// Seed the summaries file BEFORE the plugin boots: the store reads the file
// once, the way the real plugin does on first use.
const summariesFile = join(home, 'chathub', 'summaries.json')
mkdirSync(join(home, 'chathub'), { recursive: true })
writeFileSync(summariesFile, JSON.stringify({
  version: 1,
  entries: [{
    id: 'sum-seed',
    createdAt: Date.now(),
    title: 'Desk posture and neck pain',
    tag: 'Cervical spine care',
    tagAuto: 'Cervical spine care',
    tagEdited: false,
    prompt: 'Desk posture and neck pain',
    model: 'gpt-5',
    source: 'live',
    degraded: false,
    reason: '',
    digest: { tag: 'Cervical spine care', consensus: ['a'], differences: [], notes: '', parsed: true },
    titles: ['ChatGPT', 'Claude'],
    answered: ['ChatGPT', 'Claude'],
    failed: [],
    links: {},
  }],
}), 'utf8')

const { apply } = await import('../index.js')

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

const routes = []
const logger = { info() {}, warn() {}, debug() {}, error() {} }
let origin = ''
const webServer = {
  register(entry) {
    routes.push(entry)
    return () => {}
  },
  getOrigin: () => origin,
}
const ctx = {
  logger,
  get: (name) => (name === 'webServer' ? webServer : undefined),
  effect: () => {},
  on: () => {},
}

apply(ctx, {})
check('routes registered', routes.length >= 3, String(routes.length))

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local')
  const match = routes.find((entry) => (entry.kind === 'exact' ? entry.path === url.pathname : url.pathname.startsWith(entry.path)))
  if (match === undefined) { res.writeHead(404); res.end('no route'); return }
  void match.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
origin = `http://127.0.0.1:${server.address().port}`

const ui = await (await fetch(`${origin}/chathub/ui`)).text()
check('the UI page is served', ui.includes('chatHub'), String(ui.length))
check('the UI ships the tag chip', ui.includes('timeline-tag'), String(ui.length))

const api = (path, init) => fetch(`${origin}/chathub/api${path}`, init)
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const listed = await (await api('/summaries')).json()
check('the seeded summary is listed', listed.value.entries.length === 1, JSON.stringify(listed.value.entries.length))
check('the list carries the tag', listed.value.entries[0].tag === 'Cervical spine care', JSON.stringify(listed.value.entries[0]))

console.log('\n-- POST /summaries/tag --')
const renamed = await (await post('/summaries/tag', { id: 'sum-seed', tag: 'Neck & desk setup' })).json()
check('the route answers ok', renamed.ok === true, JSON.stringify(renamed))
check('it returns the stored tag', renamed.value.tag === 'Neck & desk setup', JSON.stringify(renamed.value))
check('it keeps the model tag', renamed.value.tagAuto === 'Cervical spine care')
check('it marks the tag edited', renamed.value.tagEdited === true)

const afterRename = await (await api('/summaries')).json()
check('the list shows the new tag', afterRename.value.entries[0].tag === 'Neck & desk setup', JSON.stringify(afterRename.value.entries[0]))

await sleep(200)
const onDisk = JSON.parse(readFileSync(summariesFile, 'utf8'))
check('the tag is persisted', onDisk.entries[0].tag === 'Neck & desk setup', JSON.stringify(onDisk.entries[0].tag))

const cleared = await (await post('/summaries/tag', { id: 'sum-seed', tag: '' })).json()
check('clearing restores the model tag', cleared.value.tag === 'Cervical spine care', JSON.stringify(cleared.value))

const unknown = await (await post('/summaries/tag', { id: 'sum-nope', tag: 'x' })).json()
check('an unknown id is reported', unknown.ok === false && unknown.error === 'unknown-summary', JSON.stringify(unknown))

const noBody = await (await api('/summaries/tag', { method: 'POST' })).json()
check('an empty body does not crash the route', noBody.ok === false, JSON.stringify(noBody))

const wrongMethod = await api('/summaries/tag')
check('GET is refused', wrongMethod.status === 405, String(wrongMethod.status))

console.log('\n-- the other summary routes still work --')
const one = await (await api('/summaries/get?id=sum-seed')).json()
check('get returns the record', one.ok === true && one.value.id === 'sum-seed')
const deleted = await (await post('/summaries/delete', { id: 'sum-seed' })).json()
check('delete works', deleted.ok === true, JSON.stringify(deleted))
const gone = await (await api('/summaries')).json()
check('the timeline is empty again', gone.value.entries.length === 0)

server.close()
rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
