import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SummaryStore, newSummaryRecord, summariesPath } from '../lib/summaries.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'chathub-tag-'))
const file = summariesPath(dir)
const quiet = { warn() {}, info() {}, debug() {} }

console.log('-- newSummaryRecord --')
const record = newSummaryRecord({ prompt: 'Neck pain and posture', digest: { tag: 'Cervical spine care', consensus: [], differences: [] } })
check('tag copied from digest', record.tag === 'Cervical spine care')
check('tagAuto mirrors it', record.tagAuto === 'Cervical spine care')
check('not marked edited', record.tagEdited === false)
check('missing tag falls back to the prompt', newSummaryRecord({ prompt: 'Desk lamp eye strain' }).tag === 'Desk lamp eye strain')
check('an empty prompt still has no tag', newSummaryRecord({ prompt: '' }).tag === '')
check('the fallback stops at the first sentence', newSummaryRecord({ prompt: 'Which lamp? I sit at a desk all day.' }).tag === 'Which lamp', newSummaryRecord({ prompt: 'Which lamp? I sit at a desk all day.' }).tag)
check('the fallback is clipped to a few words', newSummaryRecord({ prompt: 'Neck pain and posture at a desk all day long' }).tag === 'Neck pain and posture')
check('a model tag beats the fallback', newSummaryRecord({ prompt: 'Neck pain and posture', digest: { tag: 'Cervical spine care' } }).tag === 'Cervical spine care')
check('tag is normalised', newSummaryRecord({ prompt: 'x', tag: '  "Lawn care."  ' }).tag === 'Lawn care')
check('over-long tag clipped', newSummaryRecord({ prompt: 'x', tag: 'one two three four five six' }).tag.split(' ').length <= 4)

console.log('\n-- SummaryStore.setTag --')
const store = new SummaryStore(file, quiet)
const a = store.add({ prompt: 'First', digest: { tag: 'First topic', consensus: [], differences: [] } })
const b = store.add({ prompt: 'Second', digest: { tag: '', consensus: [], differences: [] } })

const renamed = store.setTag(a.id, 'My own label')
check('returns the record', renamed !== null && renamed.id === a.id)
check('tag overwritten', renamed.tag === 'My own label')
check('auto tag kept', renamed.tagAuto === 'First topic')
check('marked edited', renamed.tagEdited === true)

const cleared = store.setTag(a.id, '   ')
check('clearing restores the auto tag', cleared.tag === 'First topic', cleared.tag)
check('clearing drops the edited flag', cleared.tagEdited === false)

const filled = store.setTag(b.id, 'Filled in later')
check('a tag can be added where the model gave none', filled.tag === 'Filled in later')
check('clearing that one keeps it (no auto tag)', store.setTag(b.id, '') === null ? false : true)

check('unknown id returns null', store.setTag('sum-nope', 'x') === null)
check('tag is cleaned on write', store.setTag(a.id, '  "Tight."  ').tag === 'Tight')

console.log('\n-- persistence --')
await new Promise((resolve) => setTimeout(resolve, 120))
const raw = JSON.parse(readFileSync(file, 'utf8'))
const stored = raw.entries.find((entry) => entry.id === a.id)
check('written to disk', stored !== undefined && stored.tag === 'Tight', JSON.stringify(stored?.tag))
check('auto tag written too', stored?.tagAuto === 'First topic')

const reloaded = new SummaryStore(file, quiet)
check('survives a reload', reloaded.get(a.id)?.tag === 'Tight')
check('reload keeps the edited flag', reloaded.get(a.id)?.tagEdited === true)

console.log('\n-- listing shape --')
const listed = reloaded.list()
check('newest first', listed[0].id === b.id, listed.map((entry) => entry.id).join(','))
check('every entry has a string tag', listed.every((entry) => typeof entry.tag === 'string'))

console.log('\n-- legacy records --')
writeFileSync(file, JSON.stringify({ version: 1, entries: [{ id: 'sum-old', createdAt: 1, title: 'Home network and wifi setup', prompt: 'Home network and wifi setup. I have a set of Asus routers.', digest: { consensus: [], differences: [] } }] }), 'utf8')
const legacy = new SummaryStore(file, quiet)
check('old record loads', legacy.get('sum-old') !== null)
check('old record gets a prompt-derived tag', legacy.get('sum-old').tag === 'Home network and wifi', JSON.stringify(legacy.get('sum-old').tag))
check('the derived tag is untagged-as-edited', legacy.get('sum-old').tagEdited === false)
check('the derived tag would survive a rename-and-clear', legacy.setTag('sum-old', 'My router') !== null && legacy.setTag('sum-old', '').tag === 'Home network and wifi')
const upgraded = legacy.setTag('sum-old', 'Backfilled')
check('old record accepts a tag', upgraded.tag === 'Backfilled')

console.log('\n-- a summary with no prompt at all --')
writeFileSync(file, JSON.stringify({ version: 1, entries: [{ id: 'sum-blank', createdAt: 1, title: '', digest: { consensus: [], differences: [] } }] }), 'utf8')
const blank = new SummaryStore(file, quiet)
check('a blank record has no tag', (blank.get('sum-blank').tag ?? '') === '', JSON.stringify(blank.get('sum-blank').tag))
check('a blank record can still be named', blank.setTag('sum-blank', 'Named later').tag === 'Named later')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
