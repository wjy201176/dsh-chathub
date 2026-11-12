/**
 * chatHub's own preferences.
 *
 * One small JSON file beside the history and the summaries. It survives the
 * chatHub window closing and the Host restarting, and it is independent of the
 * Edge profile, so resetting the browser does not reset the language.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The languages the chatHub window's interface offers. */
export const LANGUAGES = ['en', 'zh']

/** The language before the user picks one. */
export const DEFAULT_LANGUAGE = 'en'

/**
 * The preferences file for one data directory.
 * @param {string} dataDir - the plugin's data directory.
 * @returns {string} absolute path of `preferences.json`.
 */
export function preferencesPath(dataDir) {
  return join(dataDir, 'preferences.json')
}

/**
 * Language preference, written atomically.
 *
 * A missing or unreadable file means the defaults; an unknown language in the
 * file is ignored rather than trusted, so a hand-edited typo cannot leave the
 * window with no dictionary.
 */
export class PreferencesStore {
  /**
   * @param {string} filePath - absolute path of `preferences.json`.
   * @param {object} [logger] - plugin logger.
   */
  constructor(filePath, logger) {
    this.filePath = filePath
    this.logger = logger ?? console
    this.values = { language: DEFAULT_LANGUAGE }
    this.loaded = false
    this.writing = null
  }

  /** Read the file once. A missing or unreadable file keeps the defaults. */
  #load() {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (LANGUAGES.includes(parsed?.language)) this.values.language = parsed.language
    } catch (error) {
      this.logger.warn?.(`chathub: could not read preferences (${String(error?.message ?? error)}); using the defaults`)
    }
  }

  /** The current preferences. */
  get() {
    this.#load()
    return { language: this.values.language }
  }

  /**
   * Update one preference.
   * @param {{ language?: string }} patch - the fields to change.
   * @returns {Promise<{ok: boolean, value?: object, error?: string}>} the stored values.
   */
  async set(patch) {
    this.#load()
    if (patch?.language !== undefined && !LANGUAGES.includes(patch.language)) {
      return { ok: false, error: 'invalid-language' }
    }
    if (patch?.language !== undefined) this.values.language = patch.language
    await this.#save()
    return { ok: true, value: this.get() }
  }

  /** Write the file through a temp file and a rename. */
  async #save() {
    if (this.writing !== null) {
      await this.writing
    }
    this.writing = (async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true })
        const temp = `${this.filePath}.tmp`
        await writeFile(temp, JSON.stringify({ version: 1, language: this.values.language }, null, 2), 'utf8')
        await rename(temp, this.filePath)
      } catch (error) {
        this.logger.warn?.(`chathub: could not save preferences: ${String(error?.message ?? error)}`)
      }
    })()
    try {
      await this.writing
    } finally {
      this.writing = null
    }
  }
}
