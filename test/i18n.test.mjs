// The chatHub window's language selector. Every visible string must have both
// an English and a Chinese entry, and every key the page or the script asks for
// must exist — a missing key is silently shown as its raw key otherwise.
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

const html = readFileSync(new URL('../ui/shell.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const enBlock = script.match(/en: \{([\s\S]*?)\n    \},\n    zh:/)
const zhBlock = script.match(/zh: \{([\s\S]*?)\n    \},\n  \}/)
const enKeys = new Set([...enBlock[1].matchAll(/'([a-z][A-Za-z0-9.]*)':/g)].map((match) => match[1]))
const zhKeys = new Set([...zhBlock[1].matchAll(/'([a-z][A-Za-z0-9.]*)':/g)].map((match) => match[1]))
const staticKeys = [...html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)].map((match) => match[1])
const callKeys = [...new Set([...script.matchAll(/\bt\('([a-z][A-Za-z0-9.]*)'/g)].map((match) => match[1]))]

console.log('-- dictionaries --')
check('English has the interface strings', enKeys.size >= 120, String(enKeys.size))
check('Chinese has every English key', [...enKeys].every((key) => zhKeys.has(key)), [...enKeys].filter((key) => !zhKeys.has(key)).slice(0, 5).join(', '))
check('Chinese adds no stray keys', [...zhKeys].every((key) => enKeys.has(key)))

console.log('\n-- the page asks only for existing keys --')
check('every data-i18n key exists', staticKeys.every((key) => enKeys.has(key) && zhKeys.has(key)), staticKeys.filter((key) => !enKeys.has(key)).join(', '))
check('every t() key exists', callKeys.every((key) => enKeys.has(key)), callKeys.filter((key) => !enKeys.has(key)).join(', '))
check('the t() helper falls back to English', script.includes("table[key] ?? I18N.en[key] ?? key"))
check('placeholders are substituted', script.includes("vars[name] === undefined ? match : String(vars[name])"))

console.log('\n-- the sidebar control --')
check('the language box exists', html.includes('id="language-select"'))
check('it offers English and Chinese', /<option value="en">English<\/option>/.test(html) && /<option value="zh">中文<\/option>/.test(html))
check('English is the first (default) option', html.indexOf('value="en"') < html.indexOf('value="zh"'))
check('its options pin their colours', html.includes('.rail-select option { color: #111; background-color: #fff; }'))
check('changing it re-renders the page', script.includes("languageSelect.addEventListener('change'") && script.includes('setLanguage(languageSelect.value)'))
check('the choice is stored on the Host', script.includes("api('prefs'") && script.includes("JSON.stringify({ language })"))
check('the stored choice is loaded at boot', script.includes('void loadPreferences()'))
check('the page language attribute switches', script.includes("document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'"))
check('dates follow the interface language', script.includes('toLocaleDateString(locale()') && script.includes('toLocaleTimeString(locale()'))
check('dynamic labels are rebuilt', script.includes('function applyDynamicLanguage()') && script.includes("refs.loadingText.textContent = t('column.loading')"))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
