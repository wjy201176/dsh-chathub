/**
 * Recovering a conversation URL for a chat recorded before chatHub kept one.
 *
 * A history entry written by an older build has the prompt and answers but no
 * conversation URL, so opening it could only show captured text. The provider
 * still holds the conversation, though, and its own history list names it â€” so
 * the URL can usually be recovered by matching the stored prompt against the
 * titles the provider shows, then VERIFYING the match against the stored answer.
 *
 * The verification matters more than the match: a wrong hit would silently
 * replace the user's chat with an unrelated one. Title similarity only proposes
 * a candidate; the answer text decides.
 */

/**
 * Click the control that reveals the conversation list, when it is collapsed.
 *
 * Harvesting and clicking cannot happen in one script: the list renders as a
 * result of the click, so the caller waits between the two.
 */
export const OPEN_HISTORY_LIST_SCRIPT = `(() => {
  const words = /history|recent|chats|conversations|sidebar/i;
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    const label = [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').trim()]
      .filter(Boolean).join(' ');
    if (label === '' || !words.test(label)) continue;
    el.click();
    return label.slice(0, 60);
  }
  return null;
})()`

/**
 * Collect the conversation links the current page exposes.
 *
 * Anchors are the one shape every provider agrees on; a sidebar that renders
 * conversations as buttons carries no URL to harvest, and those providers simply
 * yield an empty list (the caller then keeps the text fallback).
 */
export const LIST_CONVERSATIONS_SCRIPT = `(() => {
  const convRe = /\\/c\\/|\\/chat\\/|\\/app\\/|\\/a\\/chat\\/s\\//;
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const seen = new Set();
  const out = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.href || '';
    if (href === '' || !convRe.test(href) || seen.has(href)) continue;
    seen.add(href);
    let text = clean(anchor.innerText);
    if (text === '') {
      // Claude nests the title in spans with no direct text node, so the
      // anchor's own innerText is empty: take the longest descendant text.
      let best = '';
      for (const node of anchor.querySelectorAll('*')) {
        const candidate = clean(node.innerText) || clean(node.textContent);
        if (candidate.length > best.length) best = candidate;
      }
      text = best;
    }
    if (text === '') text = clean(anchor.getAttribute('aria-label')) || clean(anchor.getAttribute('title'));
    out.push({ href, text: text.slice(0, 120) });
  }
  return out.slice(0, 80);
})()`

/**
 * Normalise text for comparison: lowercase, and drop everything that is not a
 * letter, digit or CJK character. Providers decorate the same string differently
 * (`You said:` vs `You said`), and those differences must not decide a match.
 * @param {unknown} value - any text.
 * @returns {string} the comparable form.
 */
export function normaliseForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * How alike two titles are, as a Dice coefficient over character bigrams.
 *
 * Bigrams are used rather than words because the providers title conversations
 * in whatever language the user wrote in: Chinese has no spaces, so a word-based
 * score would see one giant token. Character bigrams work for both, and are
 * stable against the truncation providers apply to long titles.
 * @param {string} a - first text.
 * @param {string} b - second text.
 * @returns {number} 0 when nothing matches, 1 when identical.
 */
export function titleSimilarity(a, b) {
  const left = normaliseForMatch(a)
  const right = normaliseForMatch(b)
  if (left.length < 2 || right.length < 2) return 0
  const aGrams = bigramSet(left)
  const bGrams = bigramSet(right)
  let shared = 0
  for (const gram of aGrams) if (bGrams.has(gram)) shared += 1
  return (2 * shared) / (aGrams.size + bGrams.size)
}

/** The set of adjacent character pairs in a normalised string. */
function bigramSet(text) {
  const set = new Set()
  for (let index = 0; index + 1 < text.length; index += 1) set.add(text.slice(index, index + 2))
  return set
}

/** Words too common to say anything about which conversation this is. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'have', 'from', 'about', 'what', 'when', 'where',
  'which', 'there', 'their', 'would', 'could', 'should', 'been', 'being', 'into', 'than', 'then',
  'them', 'they', 'your', 'are', 'was', 'were', 'has', 'had', 'not', 'but', 'all', 'can', 'will',
  'its', 'our', 'out', 'one', 'any', 'how', 'why', 'who', 'his', 'her', 'use', 'using', 'some',
  'more', 'most', 'also', 'just', 'like', 'make', 'made', 'does', 'did', 'you', 'she', 'him',
])

/**
 * The words in a text worth comparing, lowercased and de-duplicated.
 * @param {string} text - any text.
 * @returns {string[]} the content words.
 */
function contentWords(text) {
  const found = String(text ?? '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []
  return [...new Set(found)].filter((word) => !STOP_WORDS.has(word))
}

/**
 * Rank conversation titles by how well they match a prompt.
 *
 * Two signals, combined because either alone is easy to fool:
 *
 * - **bigram coverage** asks how much of the TITLE the prompt accounts for. It is
 *   asymmetric on purpose: a short title pulled from a long prompt should score
 *   high, while a plain Dice coefficient penalises it for the prompt's length and
 *   lets long unrelated titles win on sheer size.
 * - **word coverage** asks how many of the title's distinctive words the prompt
 *   contains, which is what separates "AI bubble vs historical cases" from
 *   "Indoor plants seasonal changes" when both share common letter pairs.
 *
 * Neither is trusted on its own: the winner is verified against the stored
 * answer before it is used.
 * @param {string} prompt - the prompt the user sent.
 * @param {Array<{ href: string, text: string }>} candidates - harvested links.
 * @returns {Array<{ href: string, text: string, score: number }>} best first.
 */
export function rankCandidates(prompt, candidates) {
  const promptGrams = bigramSet(normaliseForMatch(prompt))
  const promptWords = new Set(contentWords(prompt))
  return [...candidates]
    .map((candidate) => {
      const title = normaliseForMatch(candidate.text)
      const titleGrams = bigramSet(title)
      let shared = 0
      for (const gram of titleGrams) if (promptGrams.has(gram)) shared += 1
      const coverage = titleGrams.size === 0 ? 0 : shared / titleGrams.size

      const titleWords = contentWords(candidate.text)
      const wordScore = titleWords.length === 0
        ? 0
        : titleWords.filter((word) => promptWords.has(word)).length / titleWords.length

      return { ...candidate, score: 0.5 * coverage + 0.5 * wordScore }
    })
    .sort((left, right) => right.score - left.score)
}

/**
 * Is this stored answer present in the transcript now on screen?
 *
 * The stored answer is a DELTA â€” the text that appeared after the prompt â€” so it
 * must appear inside the full conversation the provider renders. A slice from
 * the middle is compared: the opening of an answer is the part most likely to be
 * page furniture, and the end is where truncation bites.
 * @param {string} stored - the answer captured when the chat happened.
 * @param {string} live - the transcript read from the page now.
 * @returns {boolean} whether the same conversation is on screen.
 */
export function answerAppearsInTranscript(stored, live) {
  const a = normaliseForMatch(stored)
  const b = normaliseForMatch(live)
  if (a.length < 40 || b.length < 40) return false
  const width = Math.min(80, Math.floor(a.length / 2))
  const start = Math.floor((a.length - width) / 2)
  const snippet = a.slice(start, start + width)
  return snippet.length >= 40 && b.includes(snippet)
}

