/**
 * Saved summaries.
 *
 * A summary is expensive to produce — it reads every column and asks a model to
 * compare them — so the result is worth keeping. Each saved record holds the
 * digest, the columns it covered, and the link back to each model's own
 * conversation, which is what makes a summary revisitable months later.
 *
 * Storage is one JSON file written through a temp file and renamed, the same
 * discipline the chat history uses: a crash mid-write must never truncate a
 * record the user cannot regenerate.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normaliseTag, USER_TAG_CHARS, USER_TAG_WORDS } from './summary.js'

/** Summaries kept before the oldest are dropped. */
export const SUMMARY_LIMIT = 300

/** How much of the prompt is kept as the timeline label. */
export const SUMMARY_TITLE_LIMIT = 90

/**
 * A short single-line label from the prompt.
 * @param {string} prompt - the prompt that was summarized.
 * @returns {string} at most {@link SUMMARY_TITLE_LIMIT} characters.
 */
export function summaryTitleOf(prompt) {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return 'Summary'
  if (flat.length <= SUMMARY_TITLE_LIMIT) return flat
  return `${flat.slice(0, SUMMARY_TITLE_LIMIT - 1).trimEnd()}…`
}

/**
 * A fallback tag for a summary whose model did not propose one.
 *
 * Reports saved before the tag existed, and reports built without a model,
 * have no topic of their own — but a row with no label is a row the reader has
 * to open to identify. The prompt's first sentence, cut to a few words, is a
 * workable topic and is clearly the prompt's own words, not an invention.
 * @param {string} prompt - the prompt that was summarized.
 * @returns {string} a short label, or '' when the prompt is empty.
 */
export function derivedTagOf(prompt) {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  // Stop at the end of the opening sentence: a prompt is often a question
  // followed by context, and the context is not the topic.
  const firstSentence = flat.split(/[.?!]\s/, 1)[0]
  return normaliseTag(firstSentence)
}

/**
 * One summary record.
 * @param {object} input - the digest and the context it was built from.
 * @returns {object} a storable record.
 */
export function newSummaryRecord(input) {
  const now = Date.now()
  // The model proposes the tag inside the digest; a caller may also pass one
  // directly (the tests do). Either way it is cleaned before it reaches a chip.
  // With no proposal at all, the prompt's opening words stand in.
  const proposed = normaliseTag(input.tag ?? input.digest?.tag)
  const tag = proposed === '' ? derivedTagOf(input.prompt) : proposed
  return {
    id: `sum-${now.toString(36)}-${randomBytes(4).toString('hex')}`,
    createdAt: now,
    title: summaryTitleOf(input.prompt),
    // The timeline labels every row with a few words so a long list stays
    // scannable. `tagAuto` keeps the model's original so clearing the user's
    // edit puts the label back instead of leaving the row blank.
    tag,
    tagAuto: tag,
    tagEdited: false,
    prompt: String(input.prompt ?? ''),
    model: String(input.model ?? ''),
    source: input.source === 'history' ? 'history' : 'live',
    degraded: input.degraded === true,
    reason: String(input.reason ?? ''),
    digest: input.digest ?? { consensus: [], differences: [], notes: '', parsed: false },
    // Only the column NAMES are kept, not the answer bodies: the digest already
    // carries everything the page renders, and the answers can be 20k characters
    // each. The links below are what let the reader get back to the source.
    titles: Array.isArray(input.titles) ? input.titles.map(String) : [],
    answered: Array.isArray(input.answered) ? input.answered.map(String) : [],
    failed: Array.isArray(input.failed)
      ? input.failed.map((entry) => ({ title: String(entry?.title ?? ''), error: String(entry?.error ?? '') }))
      : [],
    // model title → that model's own conversation URL.
    links: input.links !== null && typeof input.links === 'object' ? { ...input.links } : {},
  }
}

/**
 * The saved-summary store: one JSON file, loaded once and written on change.
 */
export class SummaryStore {
  /**
   * @param {string} filePath - absolute path of `summaries.json`.
   * @param {object} [logger] - plugin logger.
   */
  constructor(filePath, logger) {
    this.filePath = filePath
    this.logger = logger ?? console
    this.entries = []
    this.loaded = false
    this.writing = null
    this.dirty = false
  }

  /** Read the file once. A missing or unreadable file starts empty. */
  #load() {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      this.entries = entries.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
      // Reports saved before tags existed have none. Give them the same
      // prompt-derived label a new report would get, in memory: the next save
      // writes it, and until then the timeline is not left with blank rows.
      for (const entry of this.entries) {
        if (typeof entry.tag === 'string' && entry.tag !== '') continue
        const derived = derivedTagOf(entry.prompt ?? entry.title)
        if (derived === '') continue
        entry.tag = derived
        entry.tagAuto = derived
        entry.tagEdited = false
      }
    } catch (error) {
      // Leave the unreadable file alone: it may be the only copy of something
      // the user cannot regenerate.
      this.logger.warn?.(`chathub: could not read summaries (${String(error?.message ?? error)}); starting empty and leaving the file in place`)
      this.entries = []
    }
  }

  /** Write the file atomically, coalescing concurrent saves. */
  async #save() {
    if (this.writing !== null) {
      this.dirty = true
      return this.writing
    }
    this.writing = (async () => {
      try {
        do {
          this.dirty = false
          await mkdir(dirname(this.filePath), { recursive: true })
          const temp = `${this.filePath}.tmp`
          await writeFile(temp, JSON.stringify({ version: 1, entries: this.entries }, null, 2), 'utf8')
          await rename(temp, this.filePath)
        } while (this.dirty)
      } catch (error) {
        this.logger.warn?.(`chathub: could not save summaries: ${String(error?.message ?? error)}`)
      } finally {
        this.writing = null
      }
    })()
    return this.writing
  }

  /** Newest first, which is the order the timeline shows. */
  list() {
    this.#load()
    // Ties on `createdAt` happen when two summaries land in the same
    // millisecond; the later insertion must still come first, so the index
    // breaks the tie rather than leaving the order to the sort's stability.
    return this.entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (b.entry.createdAt ?? 0) - (a.entry.createdAt ?? 0) || b.index - a.index)
      .map(({ entry }) => entry)
  }

  /**
   * One summary by id.
   * @param {string} id - the summary id.
   * @returns {object | null} the record, or null.
   */
  get(id) {
    this.#load()
    return this.entries.find((entry) => entry.id === id) ?? null
  }

  /**
   * Store a new summary.
   * @param {object} input - see {@link newSummaryRecord}.
   * @returns {object} the stored record.
   */
  add(input) {
    this.#load()
    const record = newSummaryRecord(input)
    this.entries.push(record)
    this.#prune()
    void this.#save()
    return record
  }

  /**
   * Remove one summary.
   * @param {string} id - the summary id.
   * @returns {boolean} whether anything was removed.
   */
  remove(id) {
    this.#load()
    const before = this.entries.length
    this.entries = this.entries.filter((entry) => entry.id !== id)
    if (this.entries.length === before) return false
    void this.#save()
    return true
  }

  /**
   * Overwrite the timeline tag on one summary.
   *
   * The model's own tag is kept in `tagAuto`; clearing the edit puts it back, so
   * an accidental empty save never loses the label the model proposed.
   * @param {string} id - the summary id.
   * @param {unknown} value - the new tag, as typed by the user.
   * @returns {object | null} the updated record, or null when unknown.
   */
  setTag(id, value) {
    this.#load()
    const entry = this.entries.find((candidate) => candidate.id === String(id ?? ''))
    if (entry === undefined) return null
    const auto = typeof entry.tagAuto === 'string' && entry.tagAuto !== ''
      ? entry.tagAuto
      : normaliseTag(entry.tag)
    const next = normaliseTag(value, { words: USER_TAG_WORDS, chars: USER_TAG_CHARS })
    entry.tagAuto = auto
    entry.tag = next === '' ? auto : next
    entry.tagEdited = entry.tag !== auto
    void this.#save()
    return entry
  }

  /** Drop the oldest entries beyond {@link SUMMARY_LIMIT}. */
  #prune() {
    if (this.entries.length <= SUMMARY_LIMIT) return
    const ordered = [...this.entries].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    const drop = new Set(ordered.slice(0, this.entries.length - SUMMARY_LIMIT).map((entry) => entry.id))
    this.entries = this.entries.filter((entry) => !drop.has(entry.id))
  }
}

/** The default location of the summaries file for one profile. */
export function summariesPath(dataDir) {
  return join(dataDir, 'summaries.json')
}
