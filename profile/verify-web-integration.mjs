/** Verify global web-tool replacement against the installed host and agent scopes. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as HostFetch from '@deepseek-ai/dsh-web-fetch-http'
import * as HostTools from '@deepseek-ai/dsh-tool-web'
import * as ExternalFetch from '../packages/web-fetch-http/lib/index.js'
import * as ExternalTools from '../packages/tool-web/lib/index.js'
import { publicHttpNetwork } from '../packages/web-fetch-http/lib/network.js'

const ctx = new Context()
const observed = []
const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    observed.push({ method: request.method, probe: request.headers['x-external-probe'], body: Buffer.concat(chunks).toString('utf8') })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ received: true }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const originalResolve = publicHttpNetwork.resolve
publicHttpNetwork.resolve = async () => [{ address: '127.0.0.1', family: 4 }]
const fibers = []

async function scopedTools(id, config, plugin = HostTools) {
  const key = { id }
  let scope
  fibers.push(await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key) }, {
    inject: ['tools', 'systemPrompt', 'web'],
  })))
  await scope.ctx.plugin(plugin, config)
  return { key, scope }
}
function fields(key) {
  const schema = ctx.tools.schemas(key).find(tool => tool.name === 'web_fetch')
  return schema ? Object.keys(schema.parameters.properties) : undefined
}

try {
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(WebRuntime, { fetchProvider: 'http' }))
  const oldProvider = await ctx.plugin(HostFetch)
  const oldTools = await ctx.plugin(HostTools, { fetch: true, search: true })
  const inherited = await scopedTools('external-web-fetch-inherited', { fetch: false, search: true })
  assert.deepEqual(fields(), ['url'])
  assert.deepEqual(fields(inherited.key), ['url'])

  // Disposal must finish before the same global tool/provider ids are reused.
  await oldTools.dispose()
  await oldProvider.dispose()
  assert.equal(fields(inherited.key), undefined)
  fibers.push(await ctx.plugin(ExternalFetch))
  fibers.push(await ctx.plugin(ExternalTools, { fetch: true, search: true }))
  assert.deepEqual(fields(), ['url', 'method', 'headers', 'body'])
  assert.deepEqual(fields(inherited.key), ['url', 'method', 'headers', 'body'])
  assert.equal(ctx.tools.schemas(inherited.key).filter(tool => tool.name === 'web_search').length, 1)

  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('external-web-integration'),
    agent: inherited.key,
    name: 'web_fetch',
    arguments: {
      url: `http://127.0.0.1:${server.address().port}/probe`,
      method: 'POST', headers: { 'x-external-probe': 'yes', 'content-type': 'application/json' },
      body: '{"probe":"external-web"}',
    },
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.deepEqual(observed, [{ method: 'POST', probe: 'yes', body: '{"probe":"external-web"}' }])

  const shadowing = await scopedTools('external-web-fetch-shadowed', { fetch: true, search: true })
  assert.deepEqual(fields(shadowing.key), ['url'], 'a preset-local release tool must still shadow the global tool')
  const externalPreset = await scopedTools('external-web-fetch-standard', { fetch: true, search: true }, ExternalTools)
  assert.deepEqual(fields(externalPreset.key), ['url', 'method', 'headers', 'body'])
  console.log('verify-web-integration: PASS — host service forwards POST/header/body; inherited and external preset scopes expose four fields; release preset-local fetch shadows the global tool')
} finally {
  publicHttpNetwork.resolve = originalResolve
  for (const fiber of fibers.reverse()) await fiber.dispose()
  await new Promise(resolve => server.close(resolve))
}
