#!/usr/bin/env node
/**
 * Run every test file in this directory.
 *
 * Plain `node:test`-free assertions: each file prints its own `ok` / `FAIL`
 * lines and exits non-zero on failure, so the runner only has to spawn them and
 * report which one broke. No dependencies, nothing to install.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

let failed = 0
for (const file of files) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [join(here, file)], { encoding: 'utf8' })
  const took = Date.now() - started
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const last = output.trim().split('\n').filter((line) => line.trim() !== '').pop() ?? ''
  if (run.status === 0) {
    console.log(`ok   ${file.padEnd(28)} ${last}  (${took}ms)`)
    continue
  }
  failed += 1
  console.log(`FAIL ${file.padEnd(28)} ${last}`)
  // Show the failing assertions, not the whole run.
  for (const line of output.split('\n')) {
    if (line.includes('FAIL')) console.log(`     ${line.trim()}`)
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed`)
if (failed > 0) process.exit(1)
