import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./prepare-web-profile.mjs', import.meta.url))
function fixture(t, bundle = '@deepseek-ai/dsh-web-app') {
  const root = mkdtempSync(join(tmpdir(), 'web-fetch-stage-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'web')
  mkdirSync(profile)
  const patch = '- id: agent-presets\n  config:\n    default: todo-tree-standard\n- id: tool-web\n  disabled: false\n'
  const manifest = JSON.stringify({ dependencies: { existing: '1.0.0' }, dsh: { profile: { bundles: [bundle] } } })
  writeFileSync(join(profile, 'cordis.patch.yml'), patch)
  writeFileSync(join(profile, 'package.json'), manifest)
  return { root, profile, patch, manifest, output: join(root, 'plan') }
}
function run(f) {
  return spawnSync(process.execPath, [script, '--profile-dir', f.profile, '--output', f.output], { encoding: 'utf8', timeout: 10000 })
}

test('prepares ordered phases and exact backups without modifying the Web profile', t => {
  const f = fixture(t)
  const result = run(f)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), f.patch)
  assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), f.manifest)
  assert.equal(readFileSync(join(f.output, 'original.patch.yml'), 'utf8'), f.patch)
  assert.equal(readFileSync(join(f.output, 'original.package.json'), 'utf8'), f.manifest)
  const plan = JSON.parse(readFileSync(join(f.output, 'plan.json'), 'utf8'))
  assert.equal(plan.applied, false)
  assert.equal(plan.sourceSha256, createHash('sha256').update(f.patch).digest('hex'))
  const phases = plan.phases.map(file => readFileSync(join(f.output, file), 'utf8'))
  assert.equal(phases.length, 4)
  for (const phase of phases) {
    assert.ok(phase.startsWith(f.patch))
    assert.ok(!phase.includes('- id: web\n'), 'host web service must be preserved')
  }
  assert.ok(!phases[0].includes('external-web-fetch-provider'))
  assert.ok(phases[1].includes('- id: web-fetch-http\n  disabled: true'))
  assert.ok(phases[2].includes('external-web-fetch-provider'))
  assert.ok(!phases[2].includes('external-web-fetch-tools'))
  assert.ok(phases[3].includes('external-web-fetch-tools'))
})

test('rejects a non-Web profile without creating staged files', t => {
  const f = fixture(t, '@deepseek-ai/dsh-headless')
  assert.notEqual(run(f).status, 0)
  assert.equal(existsSync(f.output), false)
})

test('refuses existing output and a previously managed source profile', t => {
  const f = fixture(t)
  assert.equal(run(f).status, 0)
  writeFileSync(join(f.output, 'plan.json'), 'keep this backup\n')
  assert.notEqual(run(f).status, 0)
  assert.equal(readFileSync(join(f.output, 'plan.json'), 'utf8'), 'keep this backup\n')
  const managed = { ...f, output: join(f.root, 'another-plan') }
  writeFileSync(join(f.profile, 'cordis.patch.yml'), f.patch + '# external-web-fetch-managed\n')
  assert.notEqual(run(managed).status, 0)
  assert.equal(existsSync(managed.output), false)
})
