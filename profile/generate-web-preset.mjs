/** Generate an opt-in standard preset with the external scoped web tools. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const { values } = parseArgs({ options: {
  'host-tree': { type: 'string', default: process.env.DSH_HOST_TREE ?? join(homedir(), '.dsh/source/current') },
  output: { type: 'string' },
} })
if (!values.output) throw new Error('Required: --output <new preset directory>')
const output = resolve(values.output)
const source = join(values['host-tree'], 'packages/preset/agent-presets/presets/standard/agent.cordis.yml')
const original = readFileSync(source, 'utf8')
const tool = fileURLToPath(new URL('../packages/tool-web/lib/index.js', import.meta.url))
if (!statSync(tool).isFile()) throw new Error(`Missing built module: ${tool}`)
const row = "  name: '@deepseek-ai/dsh-tool-web'\n"
if (original.split(row).length !== 2) {
  throw new Error('Expected exactly one release tool-web row in the shipped standard preset')
}
const composition = original.replace(row, `  name: ${JSON.stringify(tool)}\n`)
mkdirSync(dirname(output), { recursive: true })
mkdirSync(output)
writeFileSync(join(output, 'agent.cordis.yml'), composition, { flag: 'wx', mode: 0o600 })
writeFileSync(join(output, 'preset.yml'), 'name: Standard + external web fetch\ndescription: Standard tools with method, headers and body support in web_fetch. Requires the external HTTP provider in the host profile.\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ output, source, tool, applied: false }, null, 2))
