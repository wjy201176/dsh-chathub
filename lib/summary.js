/**
 * Summarize: read what every column answered, then ask a model to produce one
 * consensus summary plus a table of where the models disagreed.
 *
 * Two halves live here, both free of cordis so they can be exercised directly:
 *
 * - `TRANSCRIPT_SCRIPT` pulls a provider's visible conversation out of its page.
 *   The columns are ordinary provider web apps, so there is no API to call —
 *   the page IS the source of truth, and it is what the user is comparing.
 * - `buildDigestPrompt` / `parseDigest` turn those answers into one structured
 *   result. The model is asked for JSON so the table is data, not markup: a
 *   markdown table would have to be re-parsed, and a malformed one would show
 *   up as broken cells in the window the user is reading.
 */

/** How much of one answer is fed to the summarizer. */
export const ANSWER_LIMIT = 6000

/** Longest a model-proposed tag may be, in words and in characters. */
export const TAG_WORDS = 4
export const TAG_CHARS = 32

/**
 * Longest a tag the USER typed may be.
 *
 * A person renaming a row is allowed more room than the model — they are
 * naming something they know — but the label still has to fit the chip, so it
 * is bounded too.
 */
export const USER_TAG_WORDS = 8
export const USER_TAG_CHARS = 56

/**
 * An answer shorter than this is treated as "no answer".
 *
 * A column that is still loading, or that answered with a single word, carries
 * nothing a comparison can use — and a near-empty answer would make the
 * summarizer report differences that are really just missing data.
 */
export const MIN_ANSWER_CHARS = 24

/**
 * Does this column text look like a real answer rather than an echo?
 *
 * The transcripts open with the user's own question (that is how the provider
 * pages are laid out), so a column that never answered still yields text — just
 * the prompt echoed back plus page chrome. Feeding that to the summarizer
 * invents a "difference" where the real situation is "this model produced
 * nothing".
 *
 * Two independent signals, both required:
 *
 * 1. enough text to say something at all;
 * 2. text that is not mostly the question repeated — measured by how much
 *    survives removing every occurrence of the question. Page chrome ("Skip to
 *    main content", the model's name, "You") survives that removal too, so the
 *    remainder must clear a share of the original, not just an absolute count.
 * @param {string} text - the captured transcript.
 * @param {string} prompt - the prompt that was sent.
 * @returns {boolean} whether there is an actual answer in there.
 */
export function looksLikeAnswer(text, prompt = '') {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length < MIN_ANSWER_CHARS) return false
  const question = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (question.length < 20) return true

  const normalise = (value) =>
    value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff ]/g, '').replace(/\s+/g, ' ').trim()
  const haystack = normalise(clean)
  const needle = normalise(question)
  if (needle === '') return true
  const remainder = haystack.split(needle).join(' ').replace(/\s+/g, ' ').trim()
  // The answer has to be a meaningful share of what was captured. An echo leaves
  // only the page's furniture, which is a small fraction of the question's own
  // length; a genuine answer is at least comparable to it.
  return remainder.length >= Math.max(MIN_ANSWER_CHARS, Math.floor(needle.length * 0.5))
}

/**
 * Split captured columns into usable answers and the ones with nothing to say.
 * @param {Array<{ title: string, text: string }>} answers - one per column.
 * @param {string} prompt - the prompt that was sent.
 * @returns {{ usable: Array<object>, empty: string[] }} the split.
 */
export function usableAnswers(answers, prompt = '') {
  const usable = []
  const empty = []
  for (const answer of answers) {
    if (looksLikeAnswer(answer.text, prompt)) usable.push(answer)
    else empty.push(answer.title)
  }
  return { usable, empty }
}

/**
 * The lowest reasoning effort a model advertises.
 *
 * A summarizer that spends its whole output budget on hidden reasoning returns
 * no visible text at all, which reads as a failure even though the model ran.
 * The cheapest supported level is requested explicitly, the same way the
 * harness's own one-line generations do it. An effort id outside the ladder is
 * still usable — it simply cannot be ordered, so the adapter's first entry wins.
 * @param {unknown} efforts - `modelInfo.reasoning.efforts` from the LLM service.
 * @returns {string | undefined} the effort id, or undefined when there is none.
 */
export function lowestReasoningEffort(efforts) {
  const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  if (!Array.isArray(efforts)) return undefined
  const ids = []
  for (const entry of efforts) {
    const id = entry !== null && typeof entry === 'object' ? entry.id : entry
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  let best
  let bestRank = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const rank = order.indexOf(id)
    if (rank < 0) continue
    if (rank < bestRank) {
      best = id
      bestRank = rank
    }
  }
  return best ?? ids[0]
}

/**
 * Read the visible conversation out of a provider page.
 *
 * Each provider keeps its transcript in a different container (measured
 * 2026-10-25 against the live columns), so this walks a candidate list from the
 * most specific to the most generic and takes the first that yields text. The
 * LAST candidate is the whole main region, which is always non-empty on a
 * loaded page — that keeps a provider whose markup changed from producing an
 * empty answer, at the cost of including some chrome.
 */
export const TRANSCRIPT_SCRIPT = `(() => {
  const clean = (text) => String(text || '')
    .replace(/\\u00a0/g, ' ')
    .replace(/[ \\t]+/g, ' ')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  const candidates = [
    // ChatGPT
    '[data-message-author-role="assistant"]',
    // Claude / Grok / Gemini / DeepSeek message blocks
    '[data-testid*="message"]',
    '[role="article"]',
    '[class*="markdown"]',
    '[class*="prose"]',
    // Last resort: the whole conversation region.
    'main',
    '[role="main"]',
  ];
  for (const selector of candidates) {
    let nodes;
    try { nodes = [...document.querySelectorAll(selector)]; } catch { continue }
    if (nodes.length === 0) continue;
    // Only keep blocks that carry real prose, so a page full of icon-only
    // "message" wrappers does not win over a plain main region.
    const texts = nodes
      .map((el) => clean(el.innerText))
      .filter((text) => text.length >= 40);
    if (texts.length === 0) continue;
    return {
      ok: true,
      selector,
      text: texts.join('\\n\\n---\\n\\n'),
      // The addressable conversation URL, so history can navigate back to the
      // provider's own view instead of re-rendering the captured text.
      href: String(location.href),
    };
  }
  return { ok: false, text: clean(document.body.innerText), selector: 'body', href: String(location.href) };
})()`

/**
 * One provider's answer, trimmed for the summarizer.
 * @param {string} title - column title, used as the model's display name.
 * @param {string} text - raw transcript text.
 * @param {number} [limit] - character budget.
 * @returns {{ title: string, text: string, truncated: boolean }}
 */
export function clipAnswer(title, text, limit = ANSWER_LIMIT) {
  const clean = String(text ?? '').trim()
  if (clean.length <= limit) return { title, text: clean, truncated: false }
  // Keep the tail: the answer's conclusion is at the end, and the opening
  // prompt is already known to the reader.
  return { title, text: clean.slice(clean.length - limit), truncated: true }
}

/**
 * Build the summarizer's prompt.
 * @param {Array<{ title: string, text: string }>} answers - one per column.
 * @param {string} [prompt] - the prompt the columns answered, when known.
 * @returns {{ system: string, user: string }}
 */
export function buildDigestPrompt(answers, prompt = '') {
  const system = [
    'You compare how several AI assistants answered the same prompt.',
    'Reply with ONE JSON object and nothing else — no prose, no code fence.',
    'Shape:',
    '{"tag": string, "consensus": string[], "differences": [{"point": string, "cells": [{"model": string, "view": string}]}], "notes": string}',
    'Rules:',
    '- "tag": a label of at most FOUR words naming what this conversation is about, for a list where several are shown at once.',
    '  Write it as a topic, not a sentence: "Autumn lawn fertilizing", "AI bubble history", "Cervical spine care".',
    '  No trailing period, no quotes, no "Summary of".',
    '- The transcript of each assistant contains the user\'s question first, then the answer. Compare the ANSWERS only; never treat the question as an answer.',
    '- "consensus": 2-5 short statements that the assistants substantially agree on. Empty array if they share nothing.',
    '- "differences": only points where the assistants genuinely disagree or where only some of them took a position.',
    '  Skip a point that every assistant states the same way. If two assistants say the same thing, that is consensus, not a difference.',
    '- "cells": one entry per assistant that has a position on that point. Include the SAME assistants in every row you can;',
    '  omit an assistant only when its answer truly says nothing about that point.',
    '- Use the assistant names EXACTLY as given in the transcript headers.',
    '- "notes": one sentence about coverage (who answered, who did not), or "" if all answered.',
    '- Be concise. Do not invent agreement or disagreement that is not there.',
  ].join('\n')

  const user = [
    prompt === '' ? 'Here is what each assistant replied.' : `The shared prompt was:\n${prompt}`,
    '',
    'Here is what each assistant replied.',
    '',
    ...answers.map((answer) => `### ${answer.title}\n${answer.text}`),
  ].join('\n')

  return { system, user }
}

/**
 * Parse the summarizer's reply.
 *
 * A model asked for JSON still occasionally wraps it in a fence or adds a
 * sentence, so the outermost object is extracted rather than assuming the whole
 * reply parses. Everything is coerced into the shape the page renders: a
 * missing or malformed section becomes an empty one, never a crash.
 * @param {string} raw - the model's reply.
 * @returns {{ tag: string, consensus: string[], differences: Array<{ point: string, cells: Array<{ model: string, view: string }> }>, notes: string, parsed: boolean }}
 */
export function parseDigest(raw) {
  const text = String(raw ?? '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const candidate = start === -1 || end <= start ? '' : text.slice(start, end + 1)
  let body = null
  if (candidate !== '') {
    try {
      body = JSON.parse(candidate)
    } catch {
      body = null
    }
  }
  if (body === null || typeof body !== 'object') {
    // Unparsable: keep the model's words rather than showing an empty page.
    return { tag: '', consensus: [], differences: [], notes: text.slice(0, 4000), parsed: false }
  }

  const consensus = Array.isArray(body.consensus)
    ? body.consensus.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
    : []

  const differences = []
  if (Array.isArray(body.differences)) {
    for (const entry of body.differences) {
      if (entry === null || typeof entry !== 'object') continue
      const point = String(entry.point ?? '').trim()
      if (point === '') continue
      const cells = []
      if (Array.isArray(entry.cells)) {
        for (const cell of entry.cells) {
          if (cell === null || typeof cell !== 'object') continue
          const model = String(cell.model ?? '').trim()
          const view = String(cell.view ?? '').trim()
          if (model === '') continue
          cells.push({ model, view })
        }
      }
      differences.push({ point, cells })
    }
  }

  return {
    tag: normaliseTag(body.tag),
    consensus,
    differences,
    notes: String(body.notes ?? '').trim(),
    parsed: true,
  }
}

/**
 * Clean a model-proposed tag into something that fits a narrow sidebar chip.
 *
 * The model is asked for at most four words, but it is a model: it may answer
 * with a sentence, wrap it in quotes, or end it with a period. The tag is
 * trimmed to {@link TAG_WORDS} words and {@link TAG_CHARS} characters so one
 * verbose answer cannot stretch the row it sits in.
 * @param {unknown} value - the proposed tag.
 * @param {{ words?: number, chars?: number }} [limits] - wider limits for a tag
 *   the user typed themselves.
 * @returns {string} a short label, or '' when there was nothing usable.
 */
export function normaliseTag(value, limits) {
  const maxWords = limits?.words ?? TAG_WORDS
  const maxChars = limits?.chars ?? TAG_CHARS
  let text = String(value ?? '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return ''
  const words = text.split(' ')
  if (words.length > maxWords) text = words.slice(0, maxWords).join(' ')
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1).trimEnd()}…`
  return text
}

/**
 * A digest built without a model.
 *
 * When the summarizer cannot run at all — no model reachable, every attempt
 * returning nothing, a timeout — the report is still worth opening: the reader
 * came to compare the columns, and the columns' own words are the comparison.
 * This lays out each answer as its own row so the table keeps its shape, and
 * says plainly that no model wrote a summary.
 * @param {Array<{ title: string, text: string }>} answers - the columns that answered.
 * @param {string} reason - why the model could not summarize.
 * @returns {object} a digest-shaped object with `parsed: false`.
 */
export function fallbackDigest(answers, reason) {
  return {
    tag: '',
    consensus: [],
    differences: answers.map((answer) => ({
      point: `${answer.title} — captured answer`,
      cells: [{ model: answer.title, view: answer.text.slice(0, 1200) }],
    })),
    notes: `No model summary was produced (${reason}), so each column's answer is shown as captured.`,
    parsed: false,
  }
}

/**
 * Render one stored chat as a self-contained HTML transcript.
 *
 * The columns' own conversations cannot be re-opened (they live on the
 * providers' servers), so this is the record chatHub kept: every prompt sent
 * from the shared bar and what each model answered.
 * @param {object} entry - the stored history entry.
 * @returns {string} a complete HTML document.
 */
export function renderHistoryPage(entry) {
  const escape = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  const turns = Array.isArray(entry.turns) ? entry.turns : []
  const models = []
  for (const turn of turns) {
    for (const id of Object.keys(turn.answers ?? {})) if (!models.includes(id)) models.push(id)
  }
  const when = new Date(entry.updatedAt ?? entry.createdAt ?? Date.now())

  const body = turns.length === 0
    ? '<p class="notes">This chat has no recorded prompts yet.</p>'
    : turns
        .map((turn, index) => {
          const answers = turn.answers ?? {}
          const cards = models
            .map((id) => {
              const text = answers[id]
              if (typeof text !== 'string' || text === '') {
                return `<div class="card off"><h4>${escape(id)}</h4><p class="notes">No answer captured.</p></div>`
              }
              return `<div class="card"><h4>${escape(id)}</h4><div class="answer">${escape(text)}</div></div>`
            })
            .join('')
          return `<section class="turn">
  <div class="prompt-head">Prompt ${index + 1} · ${escape(new Date(turn.at ?? when).toLocaleString())}</div>
  <div class="prompt">${escape(turn.prompt ?? '')}</div>
  <div class="cards">${cards}</div>
</section>`
        })
        .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>chatHub history — ${escape(entry.title || '(untitled)')}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfd; --panel:#fff; --text:#1c1d21; --muted:#6b6f76; --line:#e3e5ea; --accent:#4c8dff; --head:#f4f6fa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --panel:#1b1e24; --text:#e8eaee; --muted:#9aa1ab; --line:#2a2f37; --head:#22262d; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 32px 48px; background:var(--bg); color:var(--text); font:14px/1.55 "Segoe UI", system-ui, sans-serif; }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { margin:0 0 22px; color:var(--muted); font-size:12px; }
  .turn { margin:0 0 26px; }
  .prompt-head { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-bottom:6px; }
  .prompt { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:8px; padding:10px 14px; white-space:pre-wrap; margin-bottom:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .card.off { opacity:.6; }
  .card h4 { margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .answer { white-space:pre-wrap; }
  .notes { margin:0; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<h1>${escape(entry.title || '(untitled)')}</h1>
<p class="sub">${escape(when.toLocaleString())} · ${turns.length} ${turns.length === 1 ? 'prompt' : 'prompts'} · ${models.length} ${models.length === 1 ? 'model' : 'models'} recorded</p>
${body}
</body>
</html>`
}

/**
 * Collect the column titles that actually produced an answer, in column order.
 * @param {Array<{ title: string, text: string }>} answers - one per column.
 * @returns {string[]} the titles that answered.
 */
export function answeringTitles(answers) {
  return answers.filter((answer) => String(answer.text ?? '').trim() !== '').map((answer) => answer.title)
}

/**
 * Render the digest as one self-contained HTML page.
 *
 * The page is opened in its own Edge window, so it carries its own styles and
 * no script: it is a report, not an app.
 * @param {object} input - digest plus the metadata the header shows.
 * @returns {string} a complete HTML document.
 */
export function renderDigestPage(input) {
  const { digest, answers, prompt, createdAt, model, failed } = input
  const degraded = input.degraded === true
  const reason = String(input.reason ?? '')
  // A reopened summary passes the tag it was saved with, so the report still
  // says what the timeline row says.
  const topic = normaliseTag(input.tag ?? digest?.tag)
  const links = input.links !== null && typeof input.links === 'object' ? input.links : {}
  const escape = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  const titles = answers.map((answer) => answer.title)
  // A reopened summary passes only the column names back, because the answer
  // bodies are not stored. Trusting the (empty) text there would report every
  // model as silent; the recorded coverage list decides instead.
  const answered = Array.isArray(input.answered)
    ? new Set(input.answered)
    : new Set(answeringTitles(answers))

  // One column per model, so every row reads across the same models in the
  // same order. A model with no position on a point shows a dash.
  const header = titles.map((title) => `<th>${escape(title)}</th>`).join('')
  const rows = digest.differences
    .map((difference) => {
      const byModel = new Map(difference.cells.map((cell) => [cell.model.toLowerCase(), cell.view]))
      const cells = titles
        .map((title) => {
          const view = byModel.get(title.toLowerCase()) ?? ''
          return view === ''
            ? '<td class="empty">—</td>'
            : `<td>${escape(view)}</td>`
        })
        .join('')
      return `<tr><th class="point">${escape(difference.point)}</th>${cells}</tr>`
    })
    .join('')

  const consensus = digest.consensus.length === 0
    ? '<li class="empty">No point of agreement was identified.</li>'
    : digest.consensus.map((item) => `<li>${escape(item)}</li>`).join('')

  const coverage = titles
    .map((title) => `<span class="chip${answered.has(title) ? '' : ' off'}">${escape(title)}</span>`)
    .join('')

  const missing = titles.filter((title) => !answered.has(title))
  const coverageNote = missing.length === 0
    ? 'Every column answered.'
    : `No answer captured from ${missing.map((title) => escape(title)).join(', ')}.`

  const failedNote = failed.length === 0
    ? ''
    : `<p class="warn">Could not read: ${failed.map((entry) => `${escape(entry.title)} (${escape(entry.error)})`).join(', ')}</p>`

  const notes = digest.notes === '' ? '' : `<p class="notes">${escape(digest.notes)}</p>`
  const parsedNote = degraded
    ? `<p class="warn">No model summary was produced${reason === '' ? '' : ` (${escape(reason)})`}, so the columns' own answers are shown instead. This report still compares them.</p>`
    : ''

  // One link per model back to that model's own conversation. These are the
  // user's private conversation URLs (not share links), so nothing is published
  // by saving a summary. They only open correctly in a browser profile that is
  // signed in to the provider, which is why the report window shares chatHub's
  // profile rather than using one of its own.
  const linkRows = titles
    .map((title) => {
      const href = String(links[title] ?? '')
      const safe = /^https:\/\//i.test(href) ? href : ''
      const label = safe === ''
        ? '<span class="nolink">no saved conversation link</span>'
        : `<a href="${escape(safe)}" target="_blank" rel="noreferrer noopener">${escape(safe)}</a>`
      return `<tr><th class="point">${escape(title)}</th><td>${label}</td></tr>`
    })
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>chatHub summary</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfd; --panel:#fff; --text:#1c1d21; --muted:#6b6f76; --line:#e3e5ea; --accent:#4c8dff; --head:#f4f6fa; --warn:#b4451f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --panel:#1b1e24; --text:#e8eaee; --muted:#9aa1ab; --line:#2a2f37; --head:#22262d; --warn:#f0a07a; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 32px 48px; background:var(--bg); color:var(--text); font:14px/1.55 "Segoe UI", system-ui, sans-serif; }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { margin:0 0 22px; color:var(--muted); font-size:12px; }
  h2 { margin:26px 0 10px; font-size:14px; letter-spacing:.02em; text-transform:uppercase; color:var(--muted); }
  .prompt { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:8px; padding:10px 14px; white-space:pre-wrap; }
  ul.consensus { margin:0; padding-left:20px; }
  ul.consensus li { margin:6px 0; }
  table { width:100%; border-collapse:separate; border-spacing:0; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { padding:10px 12px; text-align:left; vertical-align:top; border-bottom:1px solid var(--line); }
  thead th { background:var(--head); font-size:12px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
  tbody th.point { width:22%; font-weight:600; background:var(--head); }
  tbody tr:last-child th, tbody tr:last-child td { border-bottom:0; }
  td.empty, li.empty { color:var(--muted); }
  .notes { margin:14px 0 0; color:var(--muted); font-size:12px; }
  .warn { margin:12px 0 0; color:var(--warn); font-size:12px; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
  .chip { font-size:11px; padding:2px 9px; border-radius:999px; border:1px solid var(--line); color:var(--text); }
  .chip.off { color:var(--muted); border-style:dashed; }
  pre.raw { white-space:pre-wrap; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; font-size:12px; }
  table.links tbody th.point { width:18%; }
  table.links td { font-size:12px; word-break:break-all; }
  table.links a { color:var(--accent); text-decoration:none; }
  table.links a:hover { text-decoration:underline; }
  .nolink { color:var(--muted); font-style:italic; }
  .topic { display:inline-block; font-size:11px; font-weight:600; letter-spacing:.02em; padding:2px 10px; border-radius:999px; border:1px solid var(--line); background:var(--panel); color:var(--text); }
</style>
</head>
<body>
<h1>What the models agreed on</h1>
<p class="sub">${escape(createdAt)} · ${degraded ? 'no model summary' : `summarized by ${escape(model)}`}${input.source === 'history' ? ' · from the stored chat' : ''}</p>
${topic === '' ? '' : `<p class="sub"><span class="topic">${escape(topic)}</span></p>`}

<h2>Prompt</h2>
<div class="prompt">${escape(prompt)}</div>

<h2>Agreed by all</h2>
<ul class="consensus">${consensus}</ul>
${notes}

<h2>Where they differ</h2>
${rows === '' ? '<p class="notes">No differences were identified.</p>' : `<table><thead><tr><th class="point">Point</th>${header}</tr></thead><tbody>${rows}</tbody></table>`}

<h2>Coverage</h2>
<div class="chips">${coverage}</div>
<p class="notes">${coverageNote}</p>
${failedNote}
${parsedNote}

<h2>Original answers</h2>
<p class="notes">Each link opens that model's own conversation in your account. These are private links, not published shares — they open signed in because this window uses the chatHub profile.</p>
<table class="links"><tbody>${linkRows}</tbody></table>
</body>
</html>`
}
