// Call the controller's tag method against a real store, the way the route does.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SummaryStore, summariesPath } from '../lib/summaries.js'
import { EdgeController } from '../lib/edge.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

check('the controller exposes setSummaryTag', typeof EdgeController.prototype.setSummaryTag === 'function')

const dir = mkdtempSync(join(tmpdir(), 'chathub-route-'))
const store = new SummaryStore(summariesPath(dir), { warn() {} })
const saved = store.add({ prompt: 'Desk posture', digest: { tag: 'Cervical spine care', consensus: [], differences: [] } })

// The route only touches `this.summaries`, so a stand-in controller is enough.
const controller = { summaries: store }
const call = (payload) => EdgeController.prototype.setSummaryTag.call(controller, payload)

const ok = await call({ id: saved.id, tag: 'Neck & desk' })
check('returns ok', ok.ok === true, JSON.stringify(ok))
check('returns the stored tag', ok.value.tag === 'Neck & desk', JSON.stringify(ok.value))
check('returns the model tag', ok.value.tagAuto === 'Cervical spine care')
check('marks it edited', ok.value.tagEdited === true)

const unknown = await call({ id: 'sum-missing', tag: 'x' })
check('unknown id is an error envelope', unknown.ok === false && unknown.error === 'unknown-summary', JSON.stringify(unknown))

const noBody = await call(undefined)
check('a missing body does not throw', noBody.ok === false, JSON.stringify(noBody))

const listed = await EdgeController.prototype.listSummaries.call(controller, { limit: 10 })
check('the list carries the tag', listed.value.entries[0].tag === 'Neck & desk', JSON.stringify(listed.value.entries[0]))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
