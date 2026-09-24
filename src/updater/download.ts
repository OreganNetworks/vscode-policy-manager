import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname } from 'node:path'

/** Arguments to {@link httpGet} */
export type HttpGetOptions = {
  /** Largest body accepted, declared or streamed */
  maxBytes: number
  /** Socket idle timeout for each request in the redirect chain */
  timeoutMs: number
  url: string
  headers?: Record<string, string>
  maxRedirects?: number
  /** Protocols that may be requested or redirected to.  Production uses the default, https only; specs add `http:` */
  protocols?: readonly string[]
}

/** A 200 with its body, or a 304 for an `If-None-Match` that still matches */
export type HttpResult = { body: Buffer; etag?: string; status: 200 } | { status: 304 }

/** Arguments to {@link downloadVerified} */
export type DownloadOptions = {
  dest: string
  /** Lower-case hex SHA-256 the body must have */
  expectedSha256: string
  maxBytes: number
  timeoutMs: number
  url: string
  protocols?: readonly string[]
}

type RawResponse = {
  body: Buffer
  status: number
  etag?: string
  location?: string
}

type RequestOnceOptions = {
  headers: Record<string, string>
  maxBytes: number
  timeoutMs: number
  url: URL
}

const DEFAULT_MAX_REDIRECTS = 5 // GitHub's release download chain is two hops
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const USER_AGENT = 'oregan-policy-manager'

/**
 * GET a URL with Node's `https`, following redirects.  GitHub's `releases/latest/download/...` answers with a
 * redirect to a signed asset URL, so URLs are logged as origin and path only - the query string carries the
 * signature.
 */
export async function httpGet({
  headers = {},
  maxBytes,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  protocols = ['https:'],
  timeoutMs,
  url,
}: HttpGetOptions): Promise<HttpResult> {
  let current = new URL(url)
  for (let hop = 0; ; hop++) {
    if (!protocols.includes(current.protocol))
      throw new Error(`refusing ${current.protocol} URL ${describeUrl(current)}`)
    const response = await requestOnce({ headers, maxBytes, timeoutMs, url: current })
    if (REDIRECT_STATUSES.has(response.status)) {
      if (!response.location) throw new Error(`HTTP ${response.status} without a Location from ${describeUrl(current)}`)
      if (hop >= maxRedirects) throw new Error(`more than ${maxRedirects} redirects from ${url}`)
      current = new URL(response.location, current)
      continue
    }
    if (response.status === 304) return { status: 304 }
    if (response.status !== 200) throw new Error(`HTTP ${response.status} from ${describeUrl(current)}`)
    return { body: response.body, etag: response.etag, status: 200 }
  }
}

/** Download a file and write it to `dest` only once its SHA-256 matches, so a bad download never touches disk */
export async function downloadVerified({ dest, expectedSha256, ...options }: DownloadOptions): Promise<void> {
  const result = await httpGet(options)
  if (result.status !== 200) throw new Error(`unexpected HTTP ${result.status} for ${options.url}`)
  const actual = sha256(result.body)
  if (actual !== expectedSha256) throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, result.body)
}

/** Lower-case hex SHA-256 */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function requestOnce({ headers, maxBytes, timeoutMs, url }: RequestOnceOptions): Promise<RawResponse> {
  const request = url.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise(function executor(resolve, reject) {
    const req = request(
      url,
      { headers: { 'User-Agent': USER_AGENT, ...headers }, method: 'GET', timeout: timeoutMs },
      function onResponse(res) {
        const status = res.statusCode ?? 0
        if (REDIRECT_STATUSES.has(status) || status === 304) {
          res.resume()
          resolve({ body: Buffer.alloc(0), location: res.headers.location, status })
          return
        }
        const declared = Number(res.headers['content-length'])
        if (declared > maxBytes) {
          res.destroy()
          reject(new Error(`response is ${declared} bytes, limit is ${maxBytes}`))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            res.destroy()
            reject(new Error(`response exceeded ${maxBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve({ body: Buffer.concat(chunks), etag: headerValue(res.headers, 'etag'), status }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`no response within ${timeoutMs} ms from ${describeUrl(url)}`)))
    req.on('error', reject)
    req.end()
  })
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function describeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`
}
