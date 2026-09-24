import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { downloadVerified, type HttpGetOptions, httpGet, sha256 } from './download'

const BODY = Buffer.from('hello')
const ETAG = '"abc"'

describe('download', () => {
  let server: Server
  let base = ''

  before(async () => {
    server = createServer(function route(request, response) {
      switch (request.url) {
        case '/ok':
          if (request.headers['if-none-match'] === ETAG) return void response.writeHead(304).end()
          return void response.writeHead(200, { 'Content-Length': BODY.length, ETag: ETAG }).end(BODY)
        case '/redirect':
          return void response.writeHead(302, { Location: '/ok' }).end()
        case '/loop':
          return void response.writeHead(302, { Location: '/loop' }).end()
        case '/to-https':
          return void response.writeHead(302, { Location: 'https://example.invalid/manifest.json' }).end()
        case '/big':
          return void response.writeHead(200, { 'Content-Length': 2048 }).end(Buffer.alloc(2048))
        case '/big-chunked':
          response.writeHead(200)
          response.write(Buffer.alloc(1024))
          return void response.end(Buffer.alloc(1024))
        case '/slow':
          return // never answers
        default:
          return void response.writeHead(404).end('not found')
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(() => {
    server.closeAllConnections()
    server.close()
  })

  /** A local plain-HTTP GET, which the production default refuses */
  const get = (path: string, overrides: Partial<HttpGetOptions> = {}) =>
    httpGet({ maxBytes: 1024, protocols: ['http:'], timeoutMs: 2000, url: `${base}${path}`, ...overrides })

  describe('httpGet', () => {
    it('returns the body and ETag of a 200', async () => {
      assert.deepEqual(await get('/ok'), { body: BODY, etag: ETAG, status: 200 })
    })

    it('returns a 304 when the ETag still matches', async () => {
      assert.deepEqual(await get('/ok', { headers: { 'If-None-Match': ETAG } }), { status: 304 })
    })

    it('follows a redirect', async () => {
      assert.deepEqual(await get('/redirect'), { body: BODY, etag: ETAG, status: 200 })
    })

    it('refuses plain http by default', async () => {
      await assert.rejects(httpGet({ maxBytes: 1024, timeoutMs: 2000, url: `${base}/ok` }), /refusing http:/)
    })

    it('refuses a redirect to a protocol that is not allowed', async () => {
      await assert.rejects(get('/to-https'), /refusing https:/)
    })

    it('gives up after too many redirects', async () => {
      await assert.rejects(get('/loop'), /more than 5 redirects/)
    })

    it('rejects any other status', async () => {
      await assert.rejects(get('/missing'), /HTTP 404/)
    })

    it('rejects a body over the limit, declared or not', async () => {
      await assert.rejects(get('/big'), /2048 bytes, limit is 1024/)
      await assert.rejects(get('/big-chunked'), /exceeded 1024 bytes/)
    })

    it('gives up on a server that never answers', async () => {
      await assert.rejects(get('/slow', { timeoutMs: 200 }), /no response within 200 ms/)
    })
  })

  describe('downloadVerified', () => {
    it('writes the file when the digest matches', async () => {
      const dest = join(await mkdtemp(join(tmpdir(), 'opm-download-')), 'updates', 'x.vsix')
      await downloadVerified({
        dest,
        expectedSha256: sha256(BODY),
        maxBytes: 1024,
        protocols: ['http:'],
        timeoutMs: 2000,
        url: `${base}/ok`,
      })
      assert.deepEqual(await readFile(dest), BODY)
    })

    it('writes nothing when the digest does not match', async () => {
      const dest = join(await mkdtemp(join(tmpdir(), 'opm-download-')), 'x.vsix')
      await assert.rejects(
        downloadVerified({
          dest,
          expectedSha256: '0'.repeat(64),
          maxBytes: 1024,
          protocols: ['http:'],
          timeoutMs: 2000,
          url: `${base}/ok`,
        }),
        /SHA-256 mismatch/,
      )
      await assert.rejects(stat(dest), { code: 'ENOENT' })
    })
  })
})
