/** Prepare ordered Web profile patches without applying them to a running instance. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const { values } = parseArgs({ options: {
  'profile-dir': { type: 'string' },
  output: { type: 'string' },
} })
if (!values['profile-dir'] || !values.output) {
  throw new Error('Required: --profile-dir <existing Web profile> --output <new staging directory>')
}
const profile = realpathSync(values['profile-dir'])
const output = resolve(values.output)
const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const source = join(profile, 'cordis.patch.yml')
const original = readFileSync(source, 'utf8')
const manifest = readFileSync(join(profile, 'package.json'), 'utf8')
if (!JSON.parse(manifest).dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app')) {
  throw new Error('The selected profile does not declare the web-app bundle')
}
if (original.includes('external-web-fetch-managed')) {
  throw new Error('This profile already contains a managed external web-fetch patch')
}
const provider = join(repo, 'packages/web-fetch-http/lib/index.js')
const tools = join(repo, 'packages/tool-web/lib/index.js')
for (const path of [provider, tools]) {
  if (!statSync(path).isFile()) throw new Error(`Missing built module: ${path}`)
}
const suffix = '\n# external-web-fetch-managed\n'
const disableTool = '- id: tool-web\n  disabled: true\n'
const disableProvider = '- id: web-fetch-http\n  disabled: true\n'
const externalProvider = { id: 'external-web-fetch-provider', name: provider }
const externalTools = { id: 'external-web-fetch-tools', name: tools, config: { fetch: true, search: true, searchTimeoutMs: 60000 } }
function patch(disables, rows = []) {
  return original.trimEnd() + '\n' + suffix + disables
    + (rows.length ? `- insert: ${JSON.stringify(rows)}\n` : '')
}
const candidates = {
  '01-disable-tool.yml': patch(disableTool),
  '02-disable-provider.yml': patch(disableTool + disableProvider),
  '03-enable-provider.yml': patch(disableTool + disableProvider, [externalProvider]),
  '04-enable-tool.yml': patch(disableTool + disableProvider, [externalProvider, externalTools]),
}
// Staging never writes the profile. Operators must verify each unload/load before advancing.
mkdirSync(output)
writeFileSync(join(output, 'original.patch.yml'), original, { mode: 0o600, flag: 'wx' })
writeFileSync(join(output, 'original.package.json'), manifest, { mode: 0o600, flag: 'wx' })
for (const [name, text] of Object.entries(candidates)) {
  writeFileSync(join(output, name), text, { mode: 0o600, flag: 'wx' })
}
const metadata = {
  profile,
  sourceSha256: createHash('sha256').update(original).digest('hex'),
  manifestSha256: createHash('sha256').update(manifest).digest('hex'),
  modules: { provider, tools },
  phases: Object.keys(candidates),
  applied: false,
}
writeFileSync(join(output, 'plan.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ output, ...metadata }, null, 2))
