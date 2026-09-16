/**
 * Load smoke for the self-use web packages.
 *
 * Mounts the built `lib/` output of `@deepseek-ai/dsh-web`,
 * `@deepseek-ai/dsh-web-fetch-http`, and `@deepseek-ai/dsh-tool-web` on a real
 * cordis Context together with the release-line `dsh-tools` and
 * `dsh-system-prompt`, then drives `web_fetch` through the tool registry against
 * a loopback HTTP server. It asserts that `method`, `headers`, and `body` reach
 * the origin, so a request beyond an anonymous GET works on this seam.
 *
 * Address resolution is replaced with a loopback address because the provider's
 * policy refuses non-public destinations by design.
 *
 * Run after `pnpm run build`: node packages/tool-web/scripts/load-smoke.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebFetchLocal from '@deepseek-ai/dsh-web-fetch-http'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import { publicHttpNetwork } from '../../web-fetch-http/lib/network.js'

/** One request the loopback origin observed. */
const observed = []

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    observed.push({
      method: req.method,
      probe: req.headers['x-probe'],
      contentType: req.headers['content-type'],
      userAgent: req.headers['user-agent'],
      body: Buffer.concat(chunks).toString('utf8'),
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// The policy refuses loopback destinations; the provider captures the resolver
// when it is constructed, so this must be replaced before the plugin mounts.
publicHttpNetwork.resolve = async () => [{ address: '127.0.0.1', family: 4 }]

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(WebRuntime, { fetchProvider: WebFetchLocal.LOCAL_FETCH_PROVIDER_ID })
const fetchFiber = await ctx.plugin(WebFetchLocal, {})
const toolFiber = await ctx.plugin(ToolWeb)

/** Run one `web_fetch` call through the tool registry. */
function call(args) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`smoke-${observed.length}-${args.method ?? 'GET'}`),
    name: 'web_fetch',
    arguments: args,
  })
}

const schemas = new Map(ctx.tools.schemas().map(schema => [schema.name, schema]))
assert.deepEqual(
  Object.keys(schemas.get('web_fetch').parameters.properties),
  ['url', 'method', 'headers', 'body'],
  'web_fetch must expose method, headers, and body',
)

const post = await call({
  url: `${base}/api`,
  method: 'POST',
  headers: { 'x-probe': 'yes', 'content-type': 'application/json' },
  body: '{"a":1}',
})
assert.equal(post.isError, false, `POST must succeed: ${JSON.stringify(post.error)}`)
const postText = post.content.map(block => block.type === 'text' ? block.text : '').join('')
assert.match(postText, /HTTP 200/)
assert.equal(observed.length, 1, 'the origin must receive exactly one request')
assert.equal(observed[0].method, 'POST')
assert.equal(observed[0].probe, 'yes')
assert.equal(observed[0].body, '{"a":1}')

// A caller header replaces the provider default instead of being sent alongside it.
const ua = await call({ url: `${base}/ua`, headers: { 'user-agent': 'probe/1' } })
assert.equal(ua.isError, false)
assert.equal(observed[1].method, 'GET')
assert.equal(observed[1].userAgent, 'probe/1')

// HEAD carries no body and is refused a body argument before the transport sees it.
const head = await call({ url: `${base}/head`, method: 'HEAD' })
assert.equal(head.isError, false)
assert.equal(observed[2].method, 'HEAD')
const bodyOnGet = await call({ url: `${base}/bad`, body: '{"a":1}' })
assert.equal(bodyOnGet.isError, true, 'a body with GET must be rejected as an argument error')

// A transport-managed header is refused as a named argument error.
const hostHeader = await call({ url: `${base}/bad`, headers: { Host: 'evil.test' } })
assert.equal(hostHeader.isError, true, 'Host must be refused')

await toolFiber.dispose()
await fetchFiber.dispose()
await new Promise(resolve => server.close(resolve))

console.log('load-smoke: ok — method, headers, and body reach the origin through the built packages')
