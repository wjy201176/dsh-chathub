// The answer-me-with-html draft: what the report page is built from.
// Every model-supplied value is text in a table cell, so it must be escaped,
// clipped and never become markup; links must stay real https anchors.
import { buildReportDraft, pdfFileName } from '../lib/report.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

const digest = {
  tag: 'Cervical spine care',
  consensus: ['Posture matters', 'Movement helps'],
  differences: [
    { point: 'Heat vs ice', cells: [{ model: 'ChatGPT', view: 'Heat first' }, { model: 'Claude', view: 'Ice first' }] },
    { point: 'Duration', cells: [{ model: 'Gemini', view: 'Two weeks' }] },
  ],
  notes: 'Grok did not answer.',
  parsed: true,
}
const answers = [
  { title: 'ChatGPT', text: 'heat helps' },
  { title: 'Claude', text: 'ice helps' },
  { title: 'Gemini', text: 'two weeks' },
  { title: 'Grok', text: '' },
]
const links = {
  ChatGPT: 'https://chatgpt.com/c/abc',
  Claude: 'https://claude.ai/chat/def',
  Gemini: 'https://gemini.google.com/app/ghi',
}

console.log('-- a full report draft --')
const draft = buildReportDraft({
  digest,
  answers,
  prompt: 'My neck hurts after desk work',
  createdAt: '2026-11-07, 7:04:21 PM',
  model: 'deepseek-flash',
  failed: [],
  links,
  source: 'live',
})
check('frontmatter opens', draft.startsWith('---\n'))
check('doc template', draft.includes('template: doc'))
check('the language is declared', draft.includes('lang: en'))
check('the tag is the title', draft.includes('title: Cervical spine care'))
check('the prompt is the subtitle', draft.includes('subtitle: My neck hurts after desk work'))
check('the source line names the summarizer', draft.includes('summarized by deepseek-flash'))
check('the file name is fixed', draft.includes('file: chathub-summary'))
check('consensus is a callout', draft.includes('```callout ok Shared position'))
check('every consensus point is listed', draft.includes('- Posture matters') && draft.includes('- Movement helps'))
check('the differences table has a header', draft.includes('| Point | Model | Position |'))
check('one row per position', draft.includes('| Heat vs ice | ChatGPT | Heat first |') && draft.includes('| Heat vs ice | Claude | Ice first |'))
check('a model missing from a row does not add one', !draft.includes('| Heat vs ice | Gemini |'))
check('the conversation is a real link', draft.includes('[Open ChatGPT conversation](https://chatgpt.com/c/abc)'))
check('a model without a link says so', draft.includes('| Grok | not saved |'))
check('coverage marks the silent model', draft.includes('| Grok | no | not captured |'))
check('coverage marks the answerers', draft.includes('| ChatGPT | ok | answered |'))
check('the digest note is kept', draft.includes('Note: Grok did not answer.'))
check('the metadata grid is present', draft.includes('```kv cols=2') && draft.includes('Created: 2026-11-07, 7:04:21 PM'))

console.log('\n-- hostile text stays text --')
const hostile = buildReportDraft({
  digest: {
    tag: 'A | B',
    consensus: ['a <b> c'],
    differences: [{ point: 'P|Q', cells: [{ model: 'M<1>', view: 'x | y <script>alert(1)</script>' }] }],
    notes: '',
    parsed: true,
  },
  answers: [{ title: 'ChatGPT', text: '' }],
  prompt: 'p',
  createdAt: 'now',
  model: 'm',
  failed: [],
  links: { ChatGPT: 'javascript:alert(1)' },
})
check('a pipe is escaped in a cell', hostile.includes('P\\|Q'))
check('angle brackets are escaped', hostile.includes('&lt;script&gt;') && !hostile.includes('<script>alert(1)'))
check('a non-https link is never an anchor', !hostile.includes('javascript:alert(1)](') && hostile.includes('not saved'))

console.log('\n-- long values are clipped --')
const long = buildReportDraft({
  digest: { tag: '', consensus: [], differences: [{ point: 'P', cells: [{ model: 'M', view: 'x'.repeat(900) }] }], notes: '', parsed: true },
  answers: [{ title: 'M', text: '' }],
  prompt: '',
  createdAt: 'now',
  model: 'm',
  failed: [],
  links: {},
})
check('a long position ends with an ellipsis', /x{100,}…/.test(long))
check('the clipped cell stays one line', !/x{300,}\n/.test(long))

console.log('\n-- a degraded report says so --')
const degraded = buildReportDraft({
  digest: { tag: '', consensus: [], differences: [], notes: '', parsed: false },
  answers: [{ title: 'ChatGPT', text: 'captured' }],
  prompt: 'p',
  createdAt: 'now',
  model: 'none',
  failed: [],
  degraded: true,
  reason: 'timeout after 120s',
  links: {},
})
check('the warn callout names the failure', degraded.includes('```callout warn No model summary'))
check('the reason survives', degraded.includes('timeout after 120s'))
check('an empty consensus becomes an info callout', degraded.includes('```callout info No shared position'))
check('the captured answer model is still listed', degraded.includes('| ChatGPT |'))

console.log('\n-- capture failures are surfaced --')
const failedCapture = buildReportDraft({
  digest: { tag: 'T', consensus: [], differences: [], notes: '', parsed: true },
  answers: [{ title: 'ChatGPT', text: '' }, { title: 'Claude', text: '' }],
  prompt: 'p',
  createdAt: 'now',
  model: 'm',
  failed: [{ title: 'Claude', error: 'timed out' }],
  links: {},
})
check('a failed column has a warn row', failedCapture.includes('| Claude | warn | capture failed: timed out |'))
check('the other column is marked unanswered', failedCapture.includes('| ChatGPT | no | not captured |'))

console.log('\n-- a reopened report keeps the saved tag --')
const reopened = buildReportDraft({
  digest: { tag: '', consensus: [], differences: [], notes: '', parsed: true },
  tag: 'Renamed by me',
  answers: [{ title: 'ChatGPT', text: '' }],
  answered: ['ChatGPT'],
  prompt: 'p',
  createdAt: 'then',
  model: 'm',
  failed: [],
  links: {},
})
check('the stored tag wins the title', reopened.includes('title: Renamed by me'))
check('the answered list decides coverage', reopened.includes('| ChatGPT | ok | answered |'))

console.log('\n-- PDF file names --')
const at = new Date(2026, 10, 7, 19, 4, 21)
check('the tag becomes a slug', pdfFileName('Cervical spine care', at) === 'chatHub-cervical-spine-care-20261107-190421.pdf', pdfFileName('Cervical spine care', at))
check('an empty tag falls back', pdfFileName('', at) === 'chatHub-summary-20261107-190421.pdf', pdfFileName('', at))
check('a non-ascii tag falls back', pdfFileName('é¢ˆæ¤ŽæŠ¤ç†', at) === 'chatHub-summary-20261107-190421.pdf', pdfFileName('é¢ˆæ¤ŽæŠ¤ç†', at))
check('hostile characters are dropped', !/[<>:"/\\|?*]/.test(pdfFileName('a<b>c:"d"', at)))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)

