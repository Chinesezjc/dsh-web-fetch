import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./generate-web-preset.mjs', import.meta.url))
const tool = fileURLToPath(new URL('../packages/tool-web/lib/index.js', import.meta.url))
function fixture(t, text) {
  const root = mkdtempSync(join(tmpdir(), 'external-web-preset-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'host/packages/preset/agent-presets/presets/standard')
  mkdirSync(directory, { recursive: true })
  const source = join(directory, 'agent.cordis.yml')
  writeFileSync(source, text)
  return { root, source, output: join(root, 'output/external-web-fetch-standard') }
}
function run(f) {
  return spawnSync(process.execPath, [script, '--host-tree', join(f.root, 'host'), '--output', f.output], { encoding: 'utf8', timeout: 10000 })
}
const release = "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n  config:\n    fetch: true\n"

test('changes only the tool module and preserves the shipped preset', t => {
  const source = '- id: other-tool\n  name: existing-tool\n' + release
  const f = fixture(t, source)
  assert.equal(run(f).status, 0)
  assert.equal(readFileSync(f.source, 'utf8'), source)
  assert.equal(readFileSync(join(f.output, 'agent.cordis.yml'), 'utf8'), source.replace("  name: '@deepseek-ai/dsh-tool-web'\n", `  name: ${JSON.stringify(tool)}\n`))
})

test('refuses missing and duplicate tool rows before writing', t => {
  for (const source of ['- id: other-tool\n', release + release]) {
    const f = fixture(t, source)
    assert.notEqual(run(f).status, 0)
    assert.equal(existsSync(f.output), false)
  }
})

test('refuses to overwrite an existing generated preset', t => {
  const f = fixture(t, release)
  assert.equal(run(f).status, 0)
  const target = join(f.output, 'preset.yml')
  writeFileSync(target, 'preserve local edit\n')
  assert.notEqual(run(f).status, 0)
  assert.equal(readFileSync(target, 'utf8'), 'preserve local edit\n')
})
