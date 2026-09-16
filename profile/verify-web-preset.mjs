/** Validate preset discovery with the host's actual profile package-resolution table. */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { createProfileResolutionGeneration, loadProfileDirectory, PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'

const { values } = parseArgs({ options: {
  root: { type: 'string' },
  'host-tree': { type: 'string', default: process.env.DSH_HOST_TREE ?? join(homedir(), '.dsh/source/current') },
  'profile-dir': { type: 'string', default: join(homedir(), '.dsh/profiles/web') },
} })
if (!values.root) throw new Error('Required: --root <generated preset root>')
const installAnchor = join(values['host-tree'], 'apps/cli/package.json')
const profile = loadProfileDirectory('dsh', values['profile-dir'], installAnchor)
const generation = await createProfileResolutionGeneration({ installAnchor, profile })
const ctx = new Context()
const fiber = await ctx.plugin(PluginPackages, { generation })
try {
  const presets = await discoverPresets(
    [{ path: values.root, trust: 'user' }],
    pathToFileURL(join(profile.dir, 'cordis.yml')).href,
    (specifier, base) => ctx.pluginPackages.packageOf(specifier, base) !== undefined,
  )
  const preset = presets.find(item => item.id === 'external-web-fetch-standard')
  assert.ok(preset, 'generated preset must be discovered')
  assert.equal(preset.broken, undefined, preset.broken)
  console.log('verify-web-preset: PASS — external-web-fetch-standard resolves through the host profile package table')
} finally {
  await fiber.dispose()
}
