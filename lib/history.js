/**
 * chatHub's chat history.
 *
 * The columns are the providers' own web apps, so their conversations live on
 * their servers and cannot be re-opened by URL. What CAN be kept is what the
 * user saw here: the prompts sent from the shared bar and what each column
 * answered. That record is what the History list shows and what an entry opens.
 *
 * Storage is one JSON file under the chatHub data directory. It is written
 * through a temp file and renamed, so a crash mid-write can never leave a
 * truncated history behind — the file is the only copy of something the user
 * cannot regenerate.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Entries kept before the oldest are dropped. */
export const HISTORY_LIMIT = 400

/** Characters kept per model answer inside one turn. */
export const ANSWER_STORE_LIMIT = 20000

/** Title length taken from the first prompt. */
export const TITLE_LIMIT = 80

/**
 * One chatHub session on disk.
 * @param {string} title - short label, taken from the first prompt.
 * @returns {object} a fresh, empty session record.
 */
export function newSessionRecord(title = '') {
  const now = Date.now()
  return {
    id: `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(title).slice(0, TITLE_LIMIT),
    createdAt: now,
    updatedAt: now,
    turns: [],
  }
}

/**
 * A short, single-line title from a prompt.
 * @param {string} prompt - the user's prompt.
 * @returns {string} at most {@link TITLE_LIMIT} characters.
 */
export function titleOf(prompt) {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= TITLE_LIMIT) return flat
  return `${flat.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
}

/**
 * Trim one model's answer for storage.
 * @param {string} text - the captured answer.
 * @returns {{ text: string, truncated: boolean }}
 */
export function clipStoredAnswer(text) {
  const clean = String(text ?? '').trim()
  if (clean.length <= ANSWER_STORE_LIMIT) return { text: clean, truncated: false }
  return { text: clean.slice(0, ANSWER_STORE_LIMIT), truncated: true }
}

/**
 * Reduce a "before" transcript and an "after" transcript to just the new part.
 *
 * The page is the source of truth and it is rewritten as the conversation grows,
 * so the new answer is whatever follows the part that was already there. Two
 * cases, in order of confidence:
 *
 * 1. `after` still starts with `before` — the usual case, and an exact suffix;
 * 2. the two share a long prefix but diverge later (a provider re-rendered a
 *    button or a timestamp) — everything after the shared prefix is new.
 *
 * When they share almost nothing the transcript was replaced wholesale (a new
 * conversation, a reload), and there is no seam to find: `after` is returned
 * whole rather than guessing, because losing the answer is worse than storing
 * the conversation twice.
 * @param {string} before - transcript captured before the prompt was sent.
 * @param {string} after - transcript captured after the answer arrived.
 * @returns {string} the new text, trimmed.
 */
export function newAnswerText(before, after) {
  const previous = String(before ?? '')
  const current = String(after ?? '')
  if (current === '') return ''
  if (previous === '') return current.trim()
  if (current.startsWith(previous)) return current.slice(previous.length).trim()

  // Longest common prefix. A re-render almost always leaves the opening of the
  // conversation intact, so the divergence point is the seam.
  const limit = Math.min(previous.length, current.length)
  let shared = 0
  while (shared < limit && previous.charCodeAt(shared) === current.charCodeAt(shared)) shared += 1
  // Require most of the old transcript to still be there; below that the page
  // was replaced rather than extended.
  if (shared >= Math.floor(previous.length * 0.6) && shared >= 40) {
    return current.slice(shared).trim()
  }
  return current.trim()
}

/**
 * The chat history store: one JSON file, loaded once and written on change.
 */
export class HistoryStore {
  /**
   * @param {string} filePath - absolute path of `history.json`.
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

  /** Read the file once. A missing or unreadable file starts an empty history. */
  #load() {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      this.entries = entries.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
    } catch (error) {
      // Keep the unreadable file rather than overwriting it: it may be the only
      // copy of a record the user cares about.
      this.logger.warn?.(`chathub: could not read history (${String(error?.message ?? error)}); starting empty and leaving the file in place`)
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
          const body = JSON.stringify({ version: 1, entries: this.entries }, null, 2)
          await writeFile(temp, body, 'utf8')
          await rename(temp, this.filePath)
        } while (this.dirty)
      } catch (error) {
        this.logger.warn?.(`chathub: could not save history: ${String(error?.message ?? error)}`)
      } finally {
        this.writing = null
      }
    })()
    return this.writing
  }

  /** Newest first, which is the order the sidebar shows. */
  list() {
    this.#load()
    return [...this.entries].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  /**
   * One entry by id.
   * @param {string} id - the session id.
   * @returns {object | null} the record, or null.
   */
  get(id) {
    this.#load()
    return this.entries.find((entry) => entry.id === id) ?? null
  }

  /** The session a prompt should be appended to: the newest one, or a new one. */
  current(prompt) {
    this.#load()
    const newest = this.list()[0]
    if (newest !== undefined && newest.turns.length === 0) return newest
    return this.start(titleOf(prompt))
  }

  /**
   * Begin a new session record.
   * @param {string} title - label for the entry.
   * @returns {object} the stored record.
   */
  start(title = '') {
    this.#load()
    const record = newSessionRecord(title)
    this.entries.push(record)
    this.#prune()
    void this.#save()
    return record
  }

  /**
   * Append a turn to a session and return the stored turn.
   * @param {string} sessionId - owning session.
   * @param {string} prompt - the prompt that was sent.
   * @returns {object | null} the turn record, or null when the session is gone.
   */
  addTurn(sessionId, prompt) {
    this.#load()
    const session = this.entries.find((entry) => entry.id === sessionId)
    if (session === undefined) return null
    const at = Date.now()
    // The random suffix matters: a millisecond timestamp alone collides when two
    // turns are appended in the same tick, and a duplicate id makes the second
    // turn's answers land on the first one.
    const turn = {
      id: `turn-${at.toString(36)}-${randomBytes(4).toString('hex')}`,
      at,
      prompt: String(prompt ?? ''),
      answers: {},
      missing: [],
      pending: true,
    }
    session.turns.push(turn)
    session.updatedAt = turn.at
    if (session.title === '') session.title = titleOf(prompt)
    void this.#save()
    return turn
  }

  /**
   * Record the captured answers for one turn.
   *
   * Text that is only the echoed question is dropped rather than stored: a
   * provider page always renders the user's prompt, so a column that never
   * answered still yields text, and storing it would make the history claim an
   * answer that does not exist. `isAnswer` decides that; a caller without a
   * filter keeps the old behaviour.
   * @param {string} sessionId - owning session.
   * @param {string} turnId - the turn being completed.
   * @param {Record<string, string>} answers - model id → answer text.
   * @param {string[]} missing - model ids that produced nothing.
   * @param {(text: string, model: string) => boolean} [isAnswer] - usability test.
   */
  completeTurn(sessionId, turnId, answers, missing, isAnswer) {
    this.#load()
    const session = this.entries.find((entry) => entry.id === sessionId)
    const turn = session?.turns.find((candidate) => candidate.id === turnId)
    if (turn === undefined) return
    const rejected = new Set()
    for (const [model, text] of Object.entries(answers)) {
      const clipped = clipStoredAnswer(text)
      if (clipped.text === '') continue
      if (typeof isAnswer === 'function' && !isAnswer(clipped.text, model)) {
        rejected.add(model)
        continue
      }
      turn.answers[model] = clipped.text
      if (clipped.truncated) turn.truncated = [...new Set([...(turn.truncated ?? []), model])]
    }
    // A model whose capture turned out to be the echoed question is "missing",
    // not "answered" — the history must say so rather than imply a reply.
    turn.missing = [...new Set([...missing, ...rejected])]
    turn.pending = false
    session.updatedAt = Date.now()
    void this.#save()
  }

  /**
   * Drop the oldest entries beyond {@link HISTORY_LIMIT}.
   * Ordering is by creation time so a long-lived session is not culled early.
   */
  #prune() {
    if (this.entries.length <= HISTORY_LIMIT) return
    const ordered = [...this.entries].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    const drop = new Set(ordered.slice(0, this.entries.length - HISTORY_LIMIT).map((entry) => entry.id))
    this.entries = this.entries.filter((entry) => !drop.has(entry.id))
  }

  /**
   * Remove one session.
   * @param {string} id - the session id.
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
}

/** The default location of the history file for one profile. */
export function historyPath(dataDir) {
  return join(dataDir, 'history.json')
}
