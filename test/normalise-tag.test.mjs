import { normaliseTag, parseDigest, TAG_WORDS, TAG_CHARS, USER_TAG_WORDS, USER_TAG_CHARS } from '../lib/summary.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

console.log('-- normaliseTag --')
check('keeps a short tag', normaliseTag('Autumn lawn fertilizing') === 'Autumn lawn fertilizing')
check('strips quotes and period', normaliseTag('  "AI bubble history."  ') === 'AI bubble history')
check('collapses whitespace', normaliseTag('AI   bubble   history') === 'AI bubble history')
check('empty stays empty', normaliseTag('') === '')
check('whitespace only stays empty', normaliseTag('   ') === '')
check('non-string is safe', normaliseTag(null) === '')

const long = normaliseTag('This is a very long sentence that should be cut down')
check('cuts to the word limit', long.split(' ').length <= TAG_WORDS, long)
check('respects the char limit', long.length <= TAG_CHARS, String(long.length))

const wide = normaliseTag('a'.repeat(80))
check('clips a single long word', wide.length <= TAG_CHARS, String(wide.length))
check('adds an ellipsis when clipped', wide.endsWith(String.fromCharCode(8230)))

console.log('\n-- a user-typed tag gets more room --')
const userTag = normaliseTag('Cervical spine care at a standing desk', { words: USER_TAG_WORDS, chars: USER_TAG_CHARS })
check('a user tag keeps up to eight words', userTag === 'Cervical spine care at a standing desk', userTag)
check('the user limit is wider than the model limit', USER_TAG_WORDS > TAG_WORDS && USER_TAG_CHARS > TAG_CHARS)
const userClipped = normaliseTag('one two three four five six seven eight nine ten eleven', { words: USER_TAG_WORDS, chars: USER_TAG_CHARS })
check('a user tag is still clipped at eight words', userClipped.split(' ').length <= USER_TAG_WORDS, userClipped)
check('a user tag respects the char limit', userClipped.length <= USER_TAG_CHARS, String(userClipped.length))

console.log('\n-- parseDigest carries the tag --')
const withTag = parseDigest(JSON.stringify({ tag: 'Cervical spine care', consensus: ['x'], differences: [] }))
check('tag parsed', withTag.tag === 'Cervical spine care')
check('tag cleaned', parseDigest(JSON.stringify({ tag: '  "Lawn care."  ' })).tag === 'Lawn care')
check('missing tag is empty', parseDigest(JSON.stringify({ consensus: [] })).tag === '')
const broken = parseDigest('not json at all')
check('unparsable digest has an empty tag', broken.tag === '')
check('unparsable still marked', broken.parsed === false)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
