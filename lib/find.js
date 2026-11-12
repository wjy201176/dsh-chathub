/**
 * Find-in-chat for the provider tabs.
 *
 * The chatHub columns are screenshots of background tabs, so the browser's own
 * Ctrl+F searches the shell page, not the model's answer. This script runs
 * inside a provider tab: it scans the rendered text, keeps every match as a
 * DOM Range, and paints them with the CSS Custom Highlight API (which does not
 * touch the provider's DOM, so the page cannot break and the marks appear in
 * the screenshot the shell shows).
 */

/** The highlight names the injected stylesheet paints. */
export const FIND_ALL = 'chathub-find'
export const FIND_ACTIVE = 'chathub-find-active'
export const FIND_STYLE_ID = 'chathub-find-style'
/** One tab stops at this many matches; the search is a reading aid, not an index. */
const FIND_LIMIT = 400

/**
 * Build the script that searches or navigates one provider tab.
 * @param {{ mode?: 'search'|'activate'|'deactivate'|'clear', query?: string, index?: number }} [options] - the action.
 * @returns {string} a self-contained expression for `Runtime.evaluate`.
 */
export function buildFindScript(options = {}) {
  const request = JSON.stringify({
    mode: String(options.mode ?? 'search'),
    query: String(options.query ?? ''),
    index: Number.isFinite(Number(options.index)) ? Math.trunc(Number(options.index)) : -1,
  })
  return `(() => {
  const REQUEST = ${request}
  const LIMIT = ${FIND_LIMIT}
  const ALL = '${FIND_ALL}'
  const ACTIVE = '${FIND_ACTIVE}'
  const STYLE_ID = '${FIND_STYLE_ID}'
  const supported = typeof CSS !== 'undefined' && CSS !== null && CSS.highlights !== undefined && typeof Highlight === 'function'
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID) !== null) return
    const host = document.head ?? document.documentElement
    if (host === null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = '::highlight(' + ALL + '){background-color:#ffd54a;color:#111}::highlight(' + ACTIVE + '){background-color:#ff3b30;color:#fff}'
    host.append(style)
  }
  const scrollToRange = (range) => {
    try {
      const element = range.startContainer.parentElement
      if (element === null) return false
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      return true
    } catch (error) {
      return false
    }
  }
  const collect = (rawQuery) => {
    const needle = rawQuery.toLowerCase()
    const ranges = []
    if (needle === '' || document.body === null) return ranges
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeValue === null || node.nodeValue === '') return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (parent === null) return NodeFilter.FILTER_REJECT
        const tag = parent.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'OPTION') return NodeFilter.FILTER_REJECT
        if (typeof parent.checkVisibility === 'function' && parent.checkVisibility() === false) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    let node = walker.nextNode()
    while (node !== null && ranges.length < LIMIT) {
      const text = node.nodeValue ?? ''
      const hay = text.toLowerCase()
      let from = 0
      for (;;) {
        const at = hay.indexOf(needle, from)
        if (at === -1) break
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        ranges.push(range)
        from = at + needle.length
        if (ranges.length >= LIMIT) break
      }
      node = walker.nextNode()
    }
    return ranges
  }

  if (REQUEST.mode === 'clear') {
    window.__chathubFind = null
    if (supported) {
      try { CSS.highlights.delete(ALL) } catch (error) {}
      try { CSS.highlights.delete(ACTIVE) } catch (error) {}
    }
    try { document.getElementById(STYLE_ID)?.remove() } catch (error) {}
    return { count: 0, index: -1, supported }
  }

  if (REQUEST.mode === 'search') {
    ensureStyle()
    const ranges = collect(REQUEST.query)
    window.__chathubFind = { ranges, index: -1, query: REQUEST.query }
    if (supported) {
      try { CSS.highlights.set(ALL, new Highlight(...ranges)) } catch (error) {}
    }
    return { count: ranges.length, index: -1, supported }
  }

  const current = window.__chathubFind
  if (current === null || current === undefined || !Array.isArray(current.ranges)) {
    return { count: 0, index: -1, supported }
  }

  if (REQUEST.mode === 'activate') {
    // A provider may re-render between the search and this click; the stored
    // ranges would then be detached and neither scroll nor paint. Collect again
    // from the same query when that happened.
    let ranges = current.ranges
    let count = ranges.length
    let index = Math.max(0, Math.min(REQUEST.index < 0 ? 0 : REQUEST.index, Math.max(0, count - 1)))
    let range = ranges[index]
    if (range === undefined || range.startContainer?.parentElement == null || range.startContainer.isConnected === false) {
      ranges = collect(current.query ?? '')
      current.ranges = ranges
      count = ranges.length
      if (count === 0) return { count: 0, index: -1, supported }
      index = Math.min(index, count - 1)
      range = ranges[index]
      if (supported) {
        try { CSS.highlights.set(ALL, new Highlight(...ranges)) } catch (error) {}
      }
    }
    current.index = index
    if (supported) {
      try { CSS.highlights.set(ACTIVE, new Highlight(range)) } catch (error) {}
    } else {
      try {
        const selection = document.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      } catch (error) {}
    }
    scrollToRange(range)
    return { count, index, supported }
  }

  if (REQUEST.mode === 'deactivate') {
    if (supported) {
      try { CSS.highlights.delete(ACTIVE) } catch (error) {}
    }
    return { count: current.ranges.length, index: current.index ?? -1, supported }
  }

  return { count: current.ranges.length, index: current.index ?? -1, supported }
})()`
}
