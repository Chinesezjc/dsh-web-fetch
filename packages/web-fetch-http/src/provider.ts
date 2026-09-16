/**
 * Safe HTTP(S) retrieval for `ctx.web`: validates and pins public IP destinations, follows
 * only same-origin redirects, enforces time and size limits, classifies and decodes text,
 * and leaves presentation to `@deepseek-ai/dsh-tool-web`. Requests carry no browser cookies
 * or ambient credentials.
 * @module @deepseek-ai/dsh-web-fetch-http/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchMethod, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Response } from 'undici'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { isNonPublicIpLiteral, publicHttpNetwork } from './network.ts'
import type { PublicAddress } from './network.ts'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface HttpFetchLimits {
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
}

/** Resolve one hostname to an already policy-validated address set. */
export type HttpFetchResolver = (hostname: string, signal: AbortSignal) => Promise<PublicAddress[]>

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/** The anonymous public HTTP(S) fetch provider. */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  /**
   * @param limits - resolved transport and response limits.
   * @param resolveAddresses - resolver that rejects non-public destinations before returning.
   */
  constructor(
    private readonly limits: HttpFetchLimits,
    private readonly resolveAddresses: HttpFetchResolver = publicHttpNetwork.resolve,
  ) {}

  /** No credentials to check — an anonymous public fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // One signal stops both the request and body read. The deadline's TimeoutReason later
    // distinguishes this provider's timeout from caller or outer-deadline cancellation.
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    return await this.followAndRead(request, d.signal)
  }

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(request.url)
    let redirectsFollowed = 0
    // Method, body, and headers all change across hops: a redirect can rewrite
    // the method to a bodyless GET and must then drop the body and its
    // describing headers, so none of the three can be read from the immutable
    // request inside the loop.
    let method: WebFetchMethod = request.method ?? 'GET'
    let body = bodyForMethod(method, request.body)
    let headers: Record<string, string> = { ...request.headers }
    // A redirect can rewrite a write method to a bodyless GET (301/302 POST,
    // 303 every write). The empty-response rule keys on whether the ORIGINAL
    // request was a write: a rewritten GET still answers a write the origin
    // may already have performed, so its empty response is a success, while a
    // plain GET keeps the pre-existing untyped-refusal contract.
    const writeRequested = method !== 'GET' && method !== 'HEAD'

    for (;;) {
      const pinned = await this.requestOnce(currentUrl, signal, method, headers, body)
      const { response } = pinned
      try {
        if (isRedirectStatus(response.status)) {
          // Enforce the redirect budget before resolving or validating the next hop.
          if (redirectsFollowed >= this.limits.maxRedirects) {
            await response.body?.cancel()
            throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          // A caller-supplied credential must never be forwarded automatically,
          // and the redirect target must not be contacted at all
          // (packages/web/AGENTS.md). Refuse before resolving the Location, so a
          // credentialed request cannot reach a second endpoint even same-origin.
          const credential = credentialHeaderName(headers)
          if (credential !== undefined) {
            await response.body?.cancel()
            throw new WebError(
              `refusing to follow a redirect (HTTP ${response.status}) for a request carrying ${credential}; retry against the redirect target directly`,
              'WEB_REDIRECT_BLOCKED',
            )
          }
          const location = response.headers.get('location')
          if (location === null) {
            // A redirect status with no Location is not a usable resource. Cancel
            // the (possibly streaming) body before throwing so no socket leaks.
            await response.body?.cancel()
            throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
          }
          const target = resolveRedirect(location, currentUrl)
          // Re-validate the target against the same transport hygiene a direct request gets: a
          // redirect must not be a back door to a credentialed, non-http(s), or over-long URL
          // that validateFetchUrl would reject.
          let validatedTarget: URL
          try {
            validatedTarget = validateFetchUrl(target.toString())
            if (!isSameOrigin(validatedTarget, currentUrl)) {
              throw new WebError(
                `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
                'WEB_REDIRECT_BLOCKED',
              )
            }
          } catch (error: unknown) {
            await response.body?.cancel()
            throw error
          }
          await response.body?.cancel()
          if (rewritesToGet(response.status, method)) {
            method = 'GET'
            body = undefined
            headers = withoutRequestBodyHeaders(headers)
          }
          currentUrl = validatedTarget
          redirectsFollowed++
          continue
        }

        return await this.readBody(response, currentUrl, signal, method, writeRequested)
      } finally {
        await pinned.close()
      }
    }
  }

  /**
   * Issue one request through the address-pinned network layer. Caller headers
   * are applied OVER the provider defaults, so a caller can replace
   * `user-agent` or `accept` but omitting them never drops the provider's
   * transport hygiene.
   */
  private async requestOnce(
    url: URL,
    signal: AbortSignal,
    method: WebFetchMethod,
    headers: Readonly<Record<string, string>>,
    body: string | undefined,
  ) {
    try {
      // A transport-managed name never reaches the transport: undici would
      // silently rewrite Host or Sec-Fetch-*, reject Keep-Alive or Expect, or
      // forward Proxy-Authorization to the origin when no proxy is
      // configured. Direct seam callers bypass the tool layer's named
      // argument errors, so the provider refuses here as its own WebError.
      const transportHeader = transportHeaderName(headers)
      if (transportHeader !== undefined) {
        throw new WebError(`header "${transportHeader}" is managed by the transport and cannot be sent`, 'WEB_PROVIDER_ERROR')
      }
      // The defaults include a deployment-configured `user-agent`; Headers
      // construction and merge sit inside the translated try so a value
      // outside HTTP field-content (a misconfigured userAgent or a caller
      // header the tool layer could not see) fails as a WebError, not a bare
      // TypeError from outside this provider's error contract.
      const merged = new Headers({
        'user-agent': this.limits.userAgent,
        'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
      })
      // Headers normalizes names case-insensitively, so a caller's `User-Agent`
      // replaces the default `user-agent` instead of being sent alongside it.
      for (const [name, value] of Object.entries(headers)) merged.set(name, value)
      const headerRecord = toRecordHeaders(merged)
      const request = {
        ...method !== 'GET' ? { method } : {},
        ...body !== undefined ? { body } : {},
      }
      // A proxied hop skips public-address resolution and pinning: the proxy performs the origin's
      // DNS, so there is no local address to validate, and pinning one would connect directly and
      // bypass the proxy. A hop the policy bypasses — every loopback and every `NO_PROXY` entry —
      // still takes the resolved-and-pinned path unchanged.
      //
      // One route decides both the branch and the dispatcher, so a mount or disposal between two
      // reads cannot return a direct, unpinned agent for a URL this branch cleared as proxied.
      //
      // An IP literal the address checks would refuse never takes it. The proxy would resolve
      // nothing — the address is already stated — so the shortcut would spend the checks for
      // nothing and let a proxy on this machine reach the very service they keep out of reach.
      const route = proxyRouteFor(url)
      if (route.proxied && !isNonPublicIpLiteral(url.hostname)) {
        return await publicHttpNetwork.requestVia(route.dispatcher, url, headerRecord, signal, request)
      }
      const addresses = await this.resolveAddresses(url.hostname, signal)
      return await publicHttpNetwork.request(url, addresses, headerRecord, signal, request)
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /**
   * Read, byte-cap, classify, and decode the final response body.
   *
   * A `HEAD` response carries no body, and per RFC 9110 §9.3.2 its
   * `Content-Length` describes the body a `GET` would have returned while
   * `Content-Type` may be absent entirely. Applying the byte cap or the
   * content-type classification to it would reject a header-only request for
   * the size or type of a body that never arrives, so `HEAD` resolves to an
   * empty text body without consulting either.
   *
   * The 204 No Content, 205 Reset Content, and 304 Not Modified statuses
   * forbid a body by definition (RFC 9110 §15.3.6, §15.3.7, §15.4.5), and a
   * 304 may also omit `Content-Type`; a caller DELETE/POST that gets one of
   * these is a success with no content, not an unsupported-type failure.
   *
   * A request whose origin was a write and whose final response carries no
   * body — a zero-length body, or a chunked stream that ends empty — resolves
   * to an empty text body without a supported `Content-Type` (RFC 9110 §8.6
   * allows a response to describe a representation with no selected
   * representation, and many write APIs return 201 with nothing). Treating
   * that as an unsupported content type would report failure — and invite a
   * destructive retry — for an operation the origin already performed. This
   * covers a write whose method a same-origin redirect rewrote to GET (301/302
   * POST, 303 every write): the hop is still answering the original write. A
   * plain GET keeps the pre-existing contract and refuses an unclassifiable
   * response whether or not it is empty.
   */
  private async readBody(
    response: Response,
    finalUrl: URL,
    signal: AbortSignal,
    method: WebFetchMethod,
    writeRequested: boolean,
  ): Promise<WebFetchResult> {
    if (method === 'HEAD' || response.status === 204 || response.status === 205 || response.status === 304) {
      await response.body?.cancel()
      return { url: finalUrl.toString(), statusCode: response.status, body: { kind: 'text', content: '' }, truncated: false }
    }
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined && !writeRequested) {
      // A plain GET keeps the pre-existing contract: apart from the bodyless
      // 204/205/304 (and HEAD) handled above, an unclassifiable response is
      // refused by type even when empty, so omitting the new optional fields
      // changes nothing about how an unadorned fetch behaves.
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    if (kind === undefined) {
      // A request that originated as a write (possibly rewritten to GET by a
      // redirect) whose response carries no body has nothing to classify, so
      // it is not an unsupported-content-type failure: a write answered with
      // nothing (a `Content-Length: 0` or a chunked stream that ends empty)
      // succeeded on the origin, and refusing it would invite a destructive
      // retry. This branch applies to any write-origin request and any status
      // other than the bodyless 204/205/304 handled above. A declared
      // positive length is a real body whose type we refuse without reading
      // it, preserving the no-wasted-download behavior of the refusal below.
      const declared = response.headers.get('content-length')
      if (declared !== null) {
        // The length is read numerically: a leading-zero spelling like `00`
        // is still a zero-length response, not a positive body to refuse.
        if (Number(declared) !== 0) {
          await response.body?.cancel()
          throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
        }
        await response.body?.cancel()
        return { url: finalUrl.toString(), statusCode: response.status, body: { kind: 'text', content: '' }, truncated: false }
      }
      // No Content-Length (chunked): probe one chunk instead of draining the
      // whole stream. A chunked binary download without a Content-Type keeps
      // the immediate-cancel refusal after its first chunk rather than paying
      // the full byte cap; a stream that ends before any chunk is empty. The
      // probe read sits inside a translated catch so a timeout, abort, or
      // disconnect before the first chunk surfaces as the provider's error
      // codes, not a raw stream fault.
      /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
      if (response.body === null) {
        return { url: finalUrl.toString(), statusCode: response.status, body: { kind: 'text', content: '' }, truncated: false }
      }
      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
      try {
        try {
          const first = await reader.read()
          if (first.done) {
            return { url: finalUrl.toString(), statusCode: response.status, body: { kind: 'text', content: '' }, truncated: false }
          }
        } catch (error: unknown) {
          // A timeout, abort, or disconnect on the probe read must surface as
          // the provider's error codes, not a raw stream fault.
          throw translateAbortOrNetwork(error, signal)
        }
      } finally {
        // Cancel whatever remains whether the stream ended or not: a refused
        // binary body must not keep draining, and an ended stream cancels as
        // a no-op.
        /* v8 ignore next -- cancel() after a completed read settles without rejecting; unobserved best-effort cleanup. */
        await reader.cancel().catch(() => undefined)
      }
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // Resolve the decoder BEFORE reading the body so an unsupported charset
    // fails without consuming the stream — but cancel the body on that failure
    // so the socket does not leak (matching the unsupported-content-type path).
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately with `WEB_FETCH_TOO_LARGE`; a stream that grows
   * past the cap is cut short (`truncatedByBytes`) rather than rejected, so a
   * server that under-reports still yields a bounded usable body.
   */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    // Undici exposes response chunks as `any`; Fetch guarantees body chunks are Uint8Array.
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        // Only DROPPED bytes count as truncation: a chunk that exactly fills the
        // remaining capacity keeps all its bytes and we read on to observe EOF,
        // so an exactly-at-cap body is not falsely flagged truncated.
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      /* v8 ignore next -- mid-stream read fault needs a network drop after headers; translate path covered by request-phase tests. */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
      await reader.cancel().catch(() => {
        // Cancel after a successful read (or after we broke past the cap) is
        // best-effort cleanup; the bytes we need are already collected.
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Methods that carry no request body, so a supplied body is dropped. */
const BODYLESS_METHODS = new Set<WebFetchMethod>(['GET', 'HEAD'])

/**
 * The body actually sent for a method. `GET` and `HEAD` have no body, and
 * `fetch` rejects one outright, so a body supplied alongside them is dropped
 * here rather than reaching the transport.
 *
 * @param method - the resolved HTTP method.
 * @param body - the caller's serialized body, if any.
 * @returns the body to send, or `undefined` when the method takes none.
 */
function bodyForMethod(method: WebFetchMethod, body: string | undefined): string | undefined {
  return BODYLESS_METHODS.has(method) ? undefined : body
}

/**
 * Whether a redirect rewrites the request method to a bodyless GET, matching
 * WHATWG `HTTP-redirect fetch` and Node's `fetch` (measured, not inferred):
 * 301 and 302 rewrite only `POST`, so a redirected `PUT`, `PATCH`, or `DELETE`
 * still reaches the target as itself; 303 rewrites every method except `GET`
 * and `HEAD`; 307 and 308 exist to preserve the method and body and never
 * rewrite.
 *
 * @param status - the redirect status code.
 * @param method - the method used for the hop that was redirected.
 * @returns whether the next hop is a bodyless GET.
 */
function rewritesToGet(status: number, method: WebFetchMethod): boolean {
  if (method === 'GET' || method === 'HEAD') return false
  if (status === 303) return true
  return (status === 301 || status === 302) && method === 'POST'
}

/**
 * Headers that describe a request body. When a redirect rewrites the method to
 * a bodyless GET the body is dropped, so these must go with it: a GET carrying
 * `Content-Type: application/json` and no body is rejected or mishandled by
 * some servers. WHATWG `HTTP-redirect fetch` removes exactly these on rewrite.
 */
const REQUEST_BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type']

/**
 * Request headers that carry a caller credential. A redirect on a request
 * bearing one of these is refused outright rather than followed, so the
 * credential can never reach a second endpoint (packages/web/AGENTS.md).
 * `Proxy-Authorization` is not listed: it names the proxy hop, not the
 * origin, and {@link TRANSPORT_HEADERS} refuses it before any request is
 * sent (a per-request value would be forwarded to the origin when no proxy
 * is configured).
 */
const CREDENTIAL_HEADERS = ['authorization', 'cookie']

/**
 * Transport-managed header names this provider refuses before sending. The
 * transport generates these itself and either silently rewrites the caller's
 * value — undici substitutes the URL authority for `Host` and its own default
 * for `Sec-Fetch-*` — or rejects the pair out of hand (`Keep-Alive`,
 * `Expect`); `Proxy-Authorization` names the proxy hop, so with no proxy
 * configured it would be forwarded verbatim to the origin, where it would
 * hand over proxy credentials. The tool layer rejects the same names as named
 * argument errors for the model path; this check covers direct seam callers
 * (`ctx.web.fetch`), which never pass through the tool's parser. `Accept-Encoding`
 * is deliberately absent: a loopback probe confirms undici forwards a caller
 * value. Authorization and Cookie stay settable — they authenticate the
 * origin and the redirect refusal above keeps them off a second endpoint.
 */
const TRANSPORT_HEADERS = new Set([
  'host', 'connection', 'proxy-connection', 'keep-alive', 'content-length',
  'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect',
  'proxy-authorization',
  'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user',
])

/**
 * The transport-managed header present on a request, for the refusal message.
 *
 * @param headers - the headers for the current hop.
 * @returns the matched header name as supplied by the caller, or `undefined`.
 */
function transportHeaderName(headers: Readonly<Record<string, string>>): string | undefined {
  return Object.keys(headers).find(name => TRANSPORT_HEADERS.has(name.toLowerCase()))
}

/**
 * The credential header present on a request, for the refusal message.
 *
 * @param headers - the headers for the current hop.
 * @returns the matched header name as supplied by the caller, or `undefined`.
 */
function credentialHeaderName(headers: Readonly<Record<string, string>>): string | undefined {
  return Object.keys(headers).find(name => CREDENTIAL_HEADERS.includes(name.toLowerCase()))
}

/**
 * Drop the body-describing headers, whatever casing the caller used.
 *
 * @param headers - the headers for the hop being rewritten.
 * @returns a copy without any {@link REQUEST_BODY_HEADERS} entry.
 */
function withoutRequestBodyHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !REQUEST_BODY_HEADERS.includes(name.toLowerCase())),
  )
}

/**
 * Copy a `Headers` instance into a plain object. The network layer's request
 * signature takes `Record<string, string>`; `Headers` has already normalized
 * names (lower-cased), which is exactly what the transport should send.
 *
 * @param headers - normalized headers from the caller merge.
 * @returns the same entries as a plain object.
 */
function toRecordHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

/** Resolve a (possibly relative) `Location` against the current URL. */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- URL resolution against a valid absolute base effectively never throws; defensive guard. */
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Translate a thrown fetch/stream error into a `WebError`, classified by the
 * deadline signal rather than the thrown value (which differs by phase: the
 * request-phase `fetch` rejects with the abort reason, while the read-phase
 * reader surfaces a bare `AbortError`). `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')`
 * recovering OUR reason means our timeout fired (`WEB_FETCH_TIMEOUT`); any other
 * abort — an upstream cancel, or a foreign/outer deadline's timeout under
 * nesting — is `WEB_ABORTED`; a throw with the signal NOT aborted is a
 * transport/network failure (`WEB_PROVIDER_ERROR`).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
