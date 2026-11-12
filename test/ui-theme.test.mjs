// Contrast guard for chatHub's two GUIs.
//
// The plugin panel lives inside DSH and must use the theme's own token pairs:
// the "primary fill" is near-white in the dark theme, so pairing it with a
// fixed white label produced white-on-white. The chatHub window has its own
// dark palette; its column actions must stay as legible as the model name.
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

// Tokens defined by @deepseek-ai/dsh-client-ui-theme (verified against the
// packaged theme CSS). A token outside this list silently drops its declaration,
// which is how a text colour can end up inherited into an invisible state.
const KNOWN_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-state-error-primary',
])

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../ui/shell.html', import.meta.url), 'utf8')
const report = readFileSync(new URL('../lib/report.js', import.meta.url), 'utf8')

console.log('-- the plugin panel uses defined theme tokens --')
const used = new Set([...client.matchAll(/var\((--dsw-alias-[a-z0-9-]+)/g)].map((match) => match[1]))
check('the panel uses theme tokens at all', used.size > 0)
const unknown = [...used].filter((token) => !KNOWN_TOKENS.has(token))
check('every token the panel uses exists in the theme', unknown.length === 0, unknown.join(', '))
check('the panel does not pair a fill with the missing on-brand token', !client.includes('label-on-brand'))
check('the primary label uses the fill\'s foreground token', client.includes('color:var(--dsw-alias-label-primary-foreground'))
check('the primary fill comes from the button token', client.includes('background:var(--dsw-alias-button-primary-fill'))
check('the primary hover uses the button hover token', client.includes('background:var(--dsw-alias-button-primary-hover'))
check('the error colour uses the state token', client.includes('var(--dsw-alias-state-error-primary'))

console.log('\n-- the chatHub window keeps its header actions legible --')
check('header buttons are the title size', /\.column-head button \{[^}]*font-size: 12px/.test(shell))
check('header buttons use the primary text colour', /\.column-head button \{[^}]*color: var\(--text\)/.test(shell))
check('header buttons are visually distinct', /\.column-head button \{[^}]*border: 1px solid var\(--line\)/.test(shell))
check('the full-screen action keeps its accent colour', shell.includes('.column-head button.full-screen { color: var(--accent)'))
check('a focused action has a visible ring', shell.includes('.column-head button:focus-visible'))

console.log('\n-- native select popups stay readable --')
check('report options pin their text colour', report.includes('select option{color:#111;background-color:#fff'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
