/**
 * Read the user's Microsoft Edge profile cookies and re-encrypt them into
 * chatHub's own Edge profile.
 *
 * Chromium stores each cookie as `v10|v11` + 12-byte nonce + AES-256-GCM
 * ciphertext + 16-byte tag, with the AES key itself wrapped by Windows DPAPI in
 * `Local State` (`os_crypt.encrypted_key`). Because the chatHub window runs
 * under the same Windows user, copying `Local State` together with the cookie
 * database is enough for the new profile to decrypt every copied cookie.
 */

import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const EDGE_ROOTS = [
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'User Data'),
  join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'User Data'),
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data'),
]

/** The Edge user-data directory that holds at least one profile, if any. */
export function findEdgeUserData() {
  for (const root of EDGE_ROOTS) {
    if (root !== '' && existsSync(root)) return root
  }
  return null
}

/** Every profile directory inside a user-data root (`Default`, `Profile 1`, …). */
export function listEdgeProfiles(userDataDir) {
  const candidates = ['Default', 'Profile 1', 'Profile 2', 'Profile 3']
  const found = []
  for (const name of candidates) {
    const dir = join(userDataDir, name)
    if (existsSync(join(dir, 'Network', 'Cookies'))) found.push({ name, dir })
  }
  return found
}

/**
 * Copy the crypto material and the cookie database out of a running-or-idle
 * Edge profile into a staging directory, so the SQLite file can be opened.
 * @returns {Promise<{ staging: string, profile: string }>} staged files.
 */
export async function stageProfile(profileDir) {
  const staging = join(tmpdir(), `chathub-cookies-${process.pid}-${Date.now()}`)
  await mkdir(join(staging, 'Network'), { recursive: true })
  const userDataDir = dirname(profileDir)
  await copyFile(join(userDataDir, 'Local State'), join(staging, 'Local State'))
  await copyFile(join(profileDir, 'Network', 'Cookies'), join(staging, 'Network', 'Cookies'))
  return { staging, profile: profileDir }
}

/**
 * Unwrap the DPAPI-protected AES key from a staged `Local State`.
 * @returns {Promise<Buffer>} the 32-byte AES key.
 */
export async function readMasterKey(staging) {
  const state = JSON.parse(await readFile(join(staging, 'Local State'), 'utf8'))
  const encoded = state?.os_crypt?.encrypted_key
  if (typeof encoded !== 'string' || encoded === '') throw new Error('no os_crypt.encrypted_key in Local State')
  const wrapped = Buffer.from(encoded, 'base64')
  if (wrapped.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('unsupported Edge key wrapping')
  return unprotectDpapi(wrapped.subarray(5))
}

/**
 * Windows DPAPI `CryptUnprotectData` for the current user.
 * @param {Buffer} data - the DPAPI blob.
 * @returns {Promise<Buffer>} the plaintext.
 */
function unprotectDpapi(data) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Edge cookie import is only supported on Windows'))
      return
    }
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$in = [Console]::In.ReadToEnd()',
      '$bytes = [Convert]::FromBase64String($in)',
      '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, "CurrentUser")',
      '[Console]::Out.Write([Convert]::ToBase64String($plain))',
    ].join('\n')
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`DPAPI unprotect failed: ${error.message}`))
          return
        }
        try {
          resolve(Buffer.from(stdout.trim(), 'base64'))
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
    child.stdin?.end(data.toString('base64'))
  })
}

/** Decrypt one Chromium cookie value. */
export function decryptCookieValue(buffer, key) {
  if (buffer.length < 3) return ''
  const prefix = buffer.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') return ''
  const nonce = buffer.subarray(3, 15)
  const tag = buffer.subarray(buffer.length - 16)
  const ciphertext = buffer.subarray(15, buffer.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

/** Encrypt one cookie value the way Chromium expects it. */
export function encryptCookieValue(value, key) {
  const nonce = Buffer.alloc(12)
  for (let index = 0; index < nonce.length; index += 1) nonce[index] = Math.floor(Math.random() * 256)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ciphertext, cipher.getAuthTag()])
}

/**
 * Read every provider cookie out of a staged Edge profile.
 *
 * The master key is only needed for encrypted values; a database whose cookies
 * are stored in plaintext (or one whose key cannot be unwrapped) still yields
 * its plaintext cookies instead of failing outright.
 * @param {{ staging: string, profile: string }} staged - staged profile paths.
 * @param {(host: string) => boolean} isWanted - provider host filter.
 * @returns {Promise<Array<object>>} cookies with a decrypted `value`.
 */
export async function readProfileCookies(staged, isWanted) {
  const key = await readMasterKey(staged.staging).catch(() => null)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(staged.staging, 'Network', 'Cookies'), { readOnly: true })
  let rows
  try {
    rows = db
      .prepare(
        `select host_key, name, value, encrypted_value, path, cast(expires_utc as text) as expires_utc,
                cast(is_secure as integer) as is_secure, cast(is_httponly as integer) as is_httponly,
                cast(samesite as integer) as samesite, cast(has_expires as integer) as has_expires
         from cookies`,
      )
      .all()
  } finally {
    db.close()
  }
  const cookies = []
  for (const row of rows) {
    const host = String(row.host_key ?? '')
    if (!isWanted(host)) continue
    let value = typeof row.value === 'string' ? row.value : ''
    if (value === '' && key !== null && row.encrypted_value !== null && row.encrypted_value !== undefined) {
      value = decryptCookieValue(Buffer.from(row.encrypted_value), key)
    }
    if (value === '') continue
    // Chromium stores microseconds since 1601; read it as text so the value is
    // never coerced into a JS number (it exceeds Number.MAX_SAFE_INTEGER).
    const expiresUtc = Number(String(row.expires_utc ?? '0'))
    cookies.push({
      host,
      name: String(row.name ?? ''),
      value,
      path: String(row.path ?? '/'),
      secure: Number(row.is_secure) === 1,
      httpOnly: Number(row.is_httponly) === 1,
      expires: Number.isFinite(expiresUtc) && expiresUtc > 0 ? expiresUtc / 1_000_000 - 11_644_473_600 : 0,
      samesite: Number(row.samesite ?? -1),
    })
  }
  return cookies
}

/**
 * Read the provider cookies out of the user's Edge profile.
 *
 * Nothing is written to disk here: the caller hands the plaintext cookies to
 * the running chatHub browser with `Network.setCookie`, and Chromium persists
 * them under chatHub's own cookie key. Writing them into the profile database
 * directly would mean re-encrypting them, and would also need the profile to be
 * closed — the running browser owns that file.
 * @param {string} targetProfileDir - chatHub's Edge profile directory (unused;
 *   kept for API compatibility).
 * @param {(host: string) => boolean} isWanted - provider host filter.
 * @returns {Promise<{ cookies: Array<object>, sourceProfile: string }>} cookies.
 */
export async function importEdgeCookies(targetProfileDir, isWanted) {
  const userDataDir = findEdgeUserData()
  if (userDataDir === null) throw new Error('Microsoft Edge profile not found')
  const profiles = listEdgeProfiles(userDataDir)
  if (profiles.length === 0) throw new Error('no Edge profile with cookies found')
  const staged = await stageProfile(profiles[0].dir)
  try {
    const cookies = await readProfileCookies(staged, isWanted)
    return { cookies, sourceProfile: profiles[0].name }
  } finally {
    await rm(staged.staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Give chatHub's profile the crypto material needed to read freshly copied
 * cookies — but only if it has none of its own yet.
 *
 * `Local State` holds `os_crypt.encrypted_key`, which wraps the AES key that
 * every cookie in that profile was encrypted with. Once the user has signed in
 * inside chatHub, the profile owns a key and a cookie database encrypted with
 * it; replacing `Local State` with the source Edge profile's copy would make
 * those cookies permanently undecryptable and silently sign the user out on
 * every launch. So an existing `Local State` is always preserved.
 * @param {string} staging - staged source profile directory.
 * @param {string} targetProfileDir - chatHub's Edge profile directory.
 * @returns {Promise<boolean>} whether a `Local State` was written.
 */
export async function seedLocalState(staging, targetProfileDir) {
  const destination = join(targetProfileDir, 'Local State')
  if (existsSync(destination)) return false
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(join(staging, 'Local State'), destination)
  return true
}

/**
 * Seed chatHub's own Edge profile from the user's Edge profile — ONCE.
 *
 * Seeding is a first-run convenience: it copies the user's Edge cookies so the
 * columns may start signed in. It must never run again afterwards, because the
 * chatHub profile is where the user's own logins and chat history accumulate;
 * overwriting its cookie database on every launch would silently sign them out
 * of everything they had signed into inside chatHub.
 *
 * A marker file records that seeding happened. `force` re-seeds on demand (the
 * UI's explicit "Import Edge cookies" action).
 *
 * `Local State` lives in the user-data ROOT (beside the profile directories),
 * so it is copied next to the profile directory, not inside it.
 * @param {string} targetProfileDir - chatHub's Edge profile directory.
 * @param {(host: string) => boolean} isWanted - provider host filter.
 * @param {{ force?: boolean }} [options] - re-seed even when already seeded.
 * @returns {Promise<boolean>} whether anything was copied.
 */
export async function seedProfile(targetProfileDir, isWanted, options = {}) {
  try {
    const marker = join(targetProfileDir, '.chathub-seeded')
    if (options.force !== true && existsSync(marker)) return false
    const userDataDir = findEdgeUserData()
    if (userDataDir === null) return false
    const profiles = listEdgeProfiles(userDataDir)
    if (profiles.length === 0) return false
    const staging = await stageProfile(profiles[0].dir)
    try {
      await mkdir(join(targetProfileDir, 'Default', 'Network'), { recursive: true })
      // Crypto material first, and only when chatHub's profile has none of its
      // own: replacing it would strand every cookie the user signed in with.
      await seedLocalState(staging.staging, targetProfileDir)
      // Merge rather than replace: keep whatever the chatHub profile already
      // holds, so a first-run seed can never erase an existing login.
      await mergeCookieDatabase(
        join(staging.staging, 'Network', 'Cookies'),
        join(targetProfileDir, 'Default', 'Network', 'Cookies'),
        isWanted,
      )
      await writeFile(marker, new Date().toISOString(), 'utf8')
      return true
    } finally {
      await rm(staging.staging, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    // A locked source (Edge is running) leaves no marker, so the next launch
    // tries again instead of treating the profile as seeded.
    return false
  }
}

/**
 * Copy provider cookies from a source Edge cookie database into chatHub's,
 * preserving every cookie already present in the destination.
 *
 * Two cases, because Chromium's cookie database carries schema and version
 * metadata that must not be invented:
 *
 * - no destination database yet (first run): copy the source wholesale, which
 *   is already a valid Chromium database;
 * - destination present: open it and insert only the provider cookies it lacks,
 *   leaving its own schema, metadata and existing logins untouched.
 *
 * Chromium holds the database open while running, so the destination is only
 * written while chatHub's Edge is not running (the caller guarantees that).
 * @param {string} sourcePath - staged source `Cookies` database.
 * @param {string} destinationPath - chatHub's `Cookies` database.
 * @param {(host: string) => boolean} isWanted - provider host filter.
 * @returns {Promise<number>} how many cookies were written.
 */
export async function mergeCookieDatabase(sourcePath, destinationPath, isWanted) {
  await mkdir(dirname(destinationPath), { recursive: true })
  if (!existsSync(destinationPath)) {
    await copyFile(sourcePath, destinationPath)
    return -1
  }

  // The staged layout is `<staging>/Network/Cookies` with `<staging>/Local State`,
  // so the key lives one level above the database file's directory.
  const source = await readProfileCookies(
    { staging: dirname(dirname(sourcePath)), profile: '' },
    isWanted,
  ).catch(() => [])
  if (source.length === 0) return 0

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(destinationPath)
  let written = 0
  try {
    const columns = new Set(
      db.prepare('pragma table_info(cookies)').all().map((row) => String(row.name)),
    )
    if (!columns.has('host_key') || !columns.has('name')) return 0
    const now = BigInt(Date.now()) * 1000n + 11644473600000000n
    for (const cookie of source) {
      const existing = db
        .prepare('select count(*) as n from cookies where host_key = ? and name = ? and path = ?')
        .get(cookie.host, cookie.name, cookie.path)
      if (Number(existing?.n ?? 0) > 0) continue
      const expires = cookie.expires > 0 ? BigInt(Math.round(cookie.expires)) * 1000000n + 11644473600000000n : 0n
      const values = {
        creation_utc: now,
        host_key: cookie.host,
        top_frame_site_key: '',
        name: cookie.name,
        value: cookie.value,
        encrypted_value: Buffer.alloc(0),
        path: cookie.path,
        expires_utc: expires,
        is_secure: cookie.secure ? 1 : 0,
        is_httponly: cookie.httpOnly ? 1 : 0,
        last_access_utc: now,
        has_expires: cookie.expires > 0 ? 1 : 0,
        is_persistent: cookie.expires > 0 ? 1 : 0,
        priority: 1,
        samesite: cookie.samesite ?? -1,
        source_scheme: 0,
        source_port: -1,
        last_update_utc: now,
        source_type: 0,
        has_cross_site_ancestor: 0,
      }
      const usable = Object.keys(values).filter((key) => columns.has(key))
      db.prepare(
        `insert into cookies (${usable.join(', ')}) values (${usable.map(() => '?').join(', ')})`,
      ).run(...usable.map((key) => values[key]))
      written += 1
    }
  } finally {
    db.close()
  }
  return written
}

/** One-line summary for the UI. */
export function describeImport(result) {
  const hosts = new Set(result.cookies.map((cookie) => cookie.host.replace(/^\./, '')))
  return { cookies: result.cookies.length, sites: hosts.size, sourceProfile: result.sourceProfile }
}

/** Write a text file next to the profile (debug helper, unused by default). */
export async function writeStagedJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

/** Home directory fallback used by the controller. */
export function defaultHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}
