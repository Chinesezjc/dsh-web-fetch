/** Create a new headless profile that loads this checkout's built web plugins. */
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const { values } = parseArgs({ options: {
  home: { type: 'string', default: process.env.DSH_HOME ?? join(homedir(), '.dsh') },
  profile: { type: 'string', default: 'external-web-fetch' },
  'dry-run': { type: 'boolean', default: false },
} })
const name = values.profile
if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || ['web', 'headless'].includes(name)) {
  throw new Error('Use a new profile name (lowercase letters, digits, hyphens); web and headless are protected')
}
const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const modules = Object.fromEntries(['web', 'web-fetch-http', 'tool-web'].map(id => {
  const entry = join(repo, 'packages', id, 'lib/index.js')
  if (!statSync(entry).isFile()) throw new Error(`Missing built entry: ${entry}; run pnpm run build`)
  return [id, entry]
}))
const directory = join(resolve(values.home), 'profiles', name)
const manifest = {
  name: `dsh-profile-${name}`,
  private: true,
  dsh: { profile: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
    patchReload: 'startup',
  } },
}
// JSON is also YAML and quotes paths without relying on the checkout's location.
const patch = [
  ...Object.keys(modules).map(id => ({ id, disabled: true })),
  { insert: [
    { id: 'selfuse-web', name: modules.web, config: {
      searchProvider: 'deepseek-official', fetchProvider: 'http',
    } },
    { id: 'selfuse-web-fetch-http', name: modules['web-fetch-http'] },
    { id: 'selfuse-tool-web', name: modules['tool-web'], config: {
      fetch: true, search: true, searchTimeoutMs: 60000,
    } },
  ] },
]
const files = {
  'package.json': JSON.stringify(manifest, null, 2) + '\n',
  'cordis.patch.yml': JSON.stringify(patch, null, 2) + '\n',
}
if (values['dry-run']) {
  console.log(JSON.stringify({ directory, modules, files: Object.keys(files) }, null, 2))
} else {
  mkdirSync(join(resolve(values.home), 'profiles'), { recursive: true })
  // An existing directory or symlink is an error, including an earlier install.
  mkdirSync(directory)
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(directory, file), content, { flag: 'wx', mode: 0o600 })
  }
  console.log(JSON.stringify({ directory, profile: name, modules }, null, 2))
}
