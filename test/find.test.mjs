// Ctrl+F in chatHub: the find script that runs inside a provider tab, and the
// shell find bar that drives it. The columns are screenshots, so the browser's
// own find cannot see the models' text; these pieces put the search in the tab.
import { readFileSync } from 'node:fs'
import { buildFindScript, FIND_ALL, FIND_ACTIVE, FIND_STYLE_ID } from '../lib/find.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

console.log('-- the tab script --')
for (const mode of ['search', 'activate', 'deactivate', 'clear']) {
  const script = buildFindScript({ mode, query: 'needle', index: 2 })
  let compiles = true
  try { new Function(script) } catch { compiles = false }
  check(`${mode} mode compiles`, compiles)
}
const tricky = 'a"b\\c\n\ttab 中文'
const trickyScript = buildFindScript({ mode: 'search', query: tricky })
check('a hostile query is embedded as a JSON string', trickyScript.includes(JSON.stringify(tricky)))
check('the mode is embedded', buildFindScript({ mode: 'clear' }).includes('"mode":"clear"'))
check('the highlight names are used', buildFindScript({ mode: 'search', query: 'x' }).includes(FIND_ALL) && buildFindScript({ mode: 'activate', index: 0 }).includes(FIND_ACTIVE))
check('the style element id is used', buildFindScript({ mode: 'search', query: 'x' }).includes(FIND_STYLE_ID))
check('the search is capped', buildFindScript({ mode: 'search', query: 'x' }).includes('LIMIT = 400'))
check('the query is kept for a re-scan', buildFindScript({ mode: 'search', query: 'x' }).includes('query: REQUEST.query'))
check('a detached range is re-collected', buildFindScript({ mode: 'activate', index: 0 }).includes('range.startContainer.isConnected === false'))
check('hidden text is skipped', buildFindScript({ mode: 'search', query: 'x' }).includes('checkVisibility'))
check('script and style text is skipped', buildFindScript({ mode: 'search', query: 'x' }).includes("tag === 'SCRIPT'"))
check('matches become Ranges', buildFindScript({ mode: 'search', query: 'x' }).includes('document.createRange()'))
check('the active match scrolls into view', buildFindScript({ mode: 'activate', index: 0 }).includes('scrollIntoView'))
check('clearing removes the highlights', buildFindScript({ mode: 'clear' }).includes('CSS.highlights.delete(ALL)'))

console.log('\n-- the shell find bar --')
const shell = readFileSync(new URL('../ui/shell.html', import.meta.url), 'utf8')
check('the find bar exists', shell.includes('id="find-bar"') && shell.includes('id="find-input"'))
check('the count and navigation exist', shell.includes('id="find-count"') && shell.includes('id="find-next"') && shell.includes('id="find-prev"'))
check('Ctrl+F is intercepted', shell.includes("key === 'f'") && shell.includes('event.ctrlKey || event.metaKey'))
check('the host search route is called', shell.includes("api('find'") && shell.includes("mode: 'search'"))
check('step activates one pane', shell.includes("mode: 'activate'"))
check('leaving a pane deactivates it', shell.includes("mode: 'deactivate'"))
check('closing clears the host highlights', shell.includes("mode: 'clear'"))
check('Enter steps and Shift+Enter goes back', shell.includes("event.shiftKey ? -1 : 1"))
check('Escape closes the bar before collapsing full screen', shell.includes('if (state.find.open)'))
check('search is debounced', shell.includes('setTimeout(() => {') && shell.includes('runFind(findInput.value)'))
check('a running search is announced', shell.includes("findCount.textContent = t('find.searching')"))
check('a click during the search is kept', shell.includes('find.pendingStep = direction') && shell.includes('find.pendingStep !== 0'))
check('the first match is selected when the search lands', shell.includes('const direction = find.pendingStep !== 0 ? find.pendingStep : 1'))
check('the counter names the column and both positions', shell.includes("t('find.position', { column: pane?.title ?? find.activePane, local, localCount, global: find.position + 1, total: find.total })"))
check('the active column is marked in the shell', shell.includes('refs.column.dataset.find = String(paneId === id)'))
check('the mark is cleared on close', shell.includes('markFindTarget(null)'))
check('the order starts at the column being read', shell.includes('ids.indexOf(state.activePane)'))
check('stale search responses are ignored', shell.includes('find.sequence !== sequence'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
