/**
 * Verifies the tool schema the `selfuse-web` profile actually composes.
 *
 * The profile disables the three release web rows and mounts this repository's
 * built packages under its own ids. This probe reads that profile's own
 * `cordis.patch.yml` with the host's overlay parser — so it checks the file the
 * host loads, not a copy of it — asserts the release rows are off, imports the
 * three module names it finds there, mounts them on a real cordis `Context`
 * together with the host's `dsh-system-prompt` and `dsh-tools`, and prints the
 * registered `web_fetch` schema. A run means the composed profile registers the
 * four-parameter `web_fetch` and keeps `web_search`.
 *
 * Run from the host source tree, so the bare `@deepseek-ai/*` specifiers below
 * resolve through that tree's tsconfig `paths`:
 *   node --import ./node_modules/tsx/dist/esm/index.mjs \
 *     ~/dsh-web-selfuse/profile/verify-profile-schema.mjs
 *
 * `DSH_SELFUSE_PATCH` overrides the profile patch path; it defaults to
 * `$DSH_HOME/profiles/selfuse-web/cordis.patch.yml`, then to
 * `~/.dsh/profiles/selfuse-web/cordis.patch.yml`.
 */

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const repo = fileURLToPath(new URL('..', import.meta.url))
const fork = join(repo, 'packages')
const patch = process.env.DSH_SELFUSE_PATCH
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/selfuse-web/cordis.patch.yml')

// The loader's overlay parser normalizes an absolute `name` to a file:// URL.
const webUrl = pathToFileURL(join(fork, 'web/lib/index.js')).href
const fetchUrl = pathToFileURL(join(fork, 'web-fetch-http/lib/index.js')).href
const toolUrl = pathToFileURL(join(fork, 'tool-web/lib/index.js')).href

const patches = loadOverlayPatches('dsh', patch)
const byId = new Map(patches.filter(entry => typeof entry.id === 'string').map(entry => [entry.id, entry]))
const insertedById = new Map(patches.flatMap(entry => entry.insert ?? []).map(row => [row.id, row]))

// The release rows must be off, or the host would mount a second ctx.web, a
// second provider under the same id, and colliding tool names.
for (const id of ['web', 'web-fetch-http', 'tool-web']) {
  assert.equal(byId.get(id)?.disabled, true, `${id} must be disabled in the profile layer`)
}

// The mounted rows must be this repository's built files, read from the profile file.
assert.equal(insertedById.get('selfuse-web')?.name, webUrl)
assert.equal(insertedById.get('selfuse-web-fetch-http')?.name, fetchUrl)
assert.equal(insertedById.get('selfuse-tool-web')?.name, toolUrl)
assert.equal(insertedById.get('selfuse-tool-web')?.config?.search, true, 'web_search must stay enabled')
assert.equal(byId.has('web-search-deepseek'), false, 'the search provider row must be left to the base layer')

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
// `web` exports its Service class as the default; the provider and the tool
// consumer are namespace plugins carrying name/inject/apply, the form the loader
// mounts directly.
await ctx.plugin((await import(webUrl)).default, insertedById.get('selfuse-web').config)
await ctx.plugin(await import(fetchUrl))
await ctx.plugin(await import(toolUrl), insertedById.get('selfuse-tool-web').config)

const schemas = new Map(ctx.tools.schemas().map(schema => [schema.name, schema]))
const fetchSchema = schemas.get('web_fetch')
assert.ok(fetchSchema, 'web_fetch must be registered')
const fields = Object.keys(fetchSchema.parameters.properties)
assert.deepEqual(fields, ['url', 'method', 'headers', 'body'])

console.log('profile patch file:', patch)
console.log('web_fetch parameters:', fields.join(', '))
console.log('web_fetch method enum:', JSON.stringify(fetchSchema.parameters.properties.method.enum))
console.log('web_fetch parameters JSON:', JSON.stringify(fetchSchema.parameters))
console.log('registered web tools:', [...schemas.keys()].filter(name => name.startsWith('web_')).join(', '))
console.log('verify-profile-schema: ok — the composed profile registers the four-field web_fetch and keeps web_search')
