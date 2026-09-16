import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const installer = fileURLToPath(new URL('./install-headless.mjs', import.meta.url))
const repo = fileURLToPath(new URL('..', import.meta.url))

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'web-fetch-install-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function run(home, ...args) {
  return spawnSync(process.execPath, [installer, '--home', home, ...args], {
    encoding: 'utf8', timeout: 10000,
  })
}

test('installs built modules into a new isolated profile without changing existing settings', t => {
  const home = fixture(t)
  for (const file of ['cordis.patch.yml', 'settings.json', 'credentials.json', 'profiles/web/package.json', 'profiles/headless/package.json']) {
    const path = join(home, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'protected sentinel\n')
  }
  const result = run(home)
  assert.equal(result.status, 0, result.stderr)
  const directory = join(home, 'profiles/external-web-fetch')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  const patch = JSON.parse(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(patch.slice(0, 3), ['web', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true })))
  assert.deepEqual(patch[3].insert.map(row => row.name), ['web', 'web-fetch-http', 'tool-web'].map(id => join(repo, 'packages', id, 'lib/index.js')))
  assert.equal(patch[3].insert[2].config.search, true)
  for (const file of ['cordis.patch.yml', 'settings.json', 'credentials.json', 'profiles/web/package.json', 'profiles/headless/package.json']) {
    assert.equal(readFileSync(join(home, file), 'utf8'), 'protected sentinel\n')
  }
})

test('rejects protected names and path traversal before writing', t => {
  const home = fixture(t)
  for (const name of ['web', 'headless', '../web', '/tmp/web', 'Uppercase']) {
    assert.notEqual(run(home, '--profile', name).status, 0, name)
  }
  assert.equal(existsSync(join(home, 'profiles')), false)
})

test('refuses to overwrite a profile, including its own previous installation', t => {
  const home = fixture(t)
  assert.equal(run(home).status, 0)
  const patch = join(home, 'profiles/external-web-fetch/cordis.patch.yml')
  writeFileSync(patch, 'user edit\n')
  assert.notEqual(run(home).status, 0)
  assert.equal(readFileSync(patch, 'utf8'), 'user edit\n')
})

test('refuses an existing profile symlink', t => {
  const home = fixture(t)
  mkdirSync(join(home, 'profiles'))
  const outside = join(home, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(home, 'profiles/external-web-fetch'))
  assert.notEqual(run(home).status, 0)
  assert.equal(existsSync(join(outside, 'package.json')), false)
})

test('dry-run previews resolved paths without creating a profile', t => {
  const home = fixture(t)
  const result = run(home, '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).directory, join(home, 'profiles/external-web-fetch'))
  assert.equal(existsSync(join(home, 'profiles')), false)
})
