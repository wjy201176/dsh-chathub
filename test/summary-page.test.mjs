// Exercise renderDigestPage with and without a tag, plus the fallback digest
// shape, so the report window always matches the timeline row.
import { renderDigestPage, fallbackDigest, parseDigest } from '../lib/summary.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

const digest = {
  tag: 'Cervical spine care',
  consensus: ['Posture matters'],
  differences: [{ point: 'Heat vs ice', cells: [{ model: 'ChatGPT', view: 'Heat' }, { model: 'Claude', view: 'Ice' }] }],
  notes: '',
  parsed: true,
}
const answers = [{ title: 'ChatGPT', text: 'heat helps' }, { title: 'Claude', text: 'ice helps' }]

console.log('-- a tagged report --')
const tagged = renderDigestPage({ digest, answers, prompt: 'neck pain', createdAt: 'now', model: 'gpt-5', failed: [], links: {} })
check('the tag is shown', tagged.includes('Cervical spine care'))
check('it is rendered as a topic chip', tagged.includes('class="topic"'))
check('the heading survives', tagged.includes('What the models agreed on'))

console.log('\n-- an untagged report --')
const untagged = renderDigestPage({ digest: { ...digest, tag: '' }, answers, prompt: 'neck pain', createdAt: 'now', model: 'gpt-5', failed: [], links: {} })
check('no chip is emitted', !untagged.includes('class="topic"'))
check('no empty chip row', !untagged.includes('<span class="topic"></span>'))

console.log('\n-- a reopened report uses the saved tag --')
const reopened = renderDigestPage({
  digest: { ...digest, tag: '' },
  tag: 'Renamed by me',
  answers: [{ title: 'ChatGPT', text: '' }],
  answered: ['ChatGPT'],
  prompt: 'neck pain',
  createdAt: 'then',
  model: 'gpt-5',
  failed: [],
  links: {},
})
check('the stored tag wins', reopened.includes('Renamed by me'))
check('a renamed tag is not shown twice', reopened.split('Renamed by me').length - 1 === 1)

console.log('\n-- the tag is escaped --')
const hostile = renderDigestPage({ digest: { ...digest, tag: '<script>alert(1)</script>' }, answers, prompt: 'p', createdAt: 'now', model: 'm', failed: [], links: {} })
check('markup in a tag cannot inject', !hostile.includes('<script>alert(1)</script>'))

console.log('\n-- the fallback digest carries a tag field --')
const fallback = fallbackDigest(answers, 'timeout')
check('fallback has an empty tag', fallback.tag === '')
check('fallback still renders', renderDigestPage({ digest: fallback, answers, prompt: 'p', createdAt: 'now', model: 'none', failed: [], degraded: true, reason: 'timeout', links: {} }).includes('No model summary was produced'))

console.log('\n-- parseDigest feeds it --')
const parsed = parseDigest(JSON.stringify({ tag: '  "Lawn care."  ', consensus: [], differences: [] }))
check('parsed tag is clean', parsed.tag === 'Lawn care')
check('parsed tag renders', renderDigestPage({ digest: parsed, answers, prompt: 'p', createdAt: 'now', model: 'm', failed: [], links: {} }).includes('Lawn care'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
