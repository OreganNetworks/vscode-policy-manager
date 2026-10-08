import assert from 'node:assert/strict'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { type DownloadOptions, type HttpGetOptions, type HttpResult } from './download'
import { createFakeLogger } from '../testing/fakeLogger'
import {
  createUpdater,
  MANIFEST_URL,
  RELEASES_URL,
  scheduleChecks,
  type TimerApi,
  type UpdaterCache,
  type UpdaterOptions,
} from './selfUpdate'

const NEWER = { sha256: 'a'.repeat(64), version: '0.2.0', vsix: 'oregan-policy-manager-0.2.0.vsix' }
const CURRENT = { sha256: 'b'.repeat(64), version: '0.1.0', vsix: 'oregan-policy-manager-0.1.0.vsix' }

const manifestResponse = (manifest: object, etag = '"v1"'): HttpResult => ({
  body: Buffer.from(JSON.stringify(manifest)),
  etag,
  status: 200,
})

/**
 * An updater over fakes: `responses` are served to the manifest GETs in order, the download writes a stub file, and
 * the cycle lock is real, in a fresh directory.
 */
async function setup(responses: HttpResult[], overrides: Partial<UpdaterOptions> = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), 'opm-updater-'))
  const logger = createFakeLogger()
  const requests: HttpGetOptions[] = []
  const downloads: DownloadOptions[] = []
  const installs: string[] = []
  const installed: string[] = []
  let saved: UpdaterCache = {}
  const updater = createUpdater({
    cache: {
      get: () => saved,
      async set(value) {
        saved = value
      },
    },
    currentVersion: '0.1.0',
    async download(options) {
      downloads.push(options)
      await mkdir(dirname(options.dest), { recursive: true })
      await writeFile(options.dest, 'vsix')
    },
    async http(options) {
      requests.push(options)
      const next = responses.shift()
      if (!next) throw new Error('no fake response queued')
      return next
    },
    async install(path) {
      installs.push(path)
    },
    logger,
    now: () => 1_000_000,
    onInstalled: version => installed.push(version),
    storageDir,
    ...overrides,
  })
  return {
    downloads,
    getSaved: () => saved,
    installed,
    installs,
    logger,
    requests,
    setSaved(value: UpdaterCache) {
      saved = value
    },
    storageDir,
    updater,
  }
}

describe('createUpdater', () => {
  it('does nothing when the stable release is the running version', async () => {
    const t = await setup([manifestResponse(CURRENT)])
    const record = await t.updater.check()
    assert.equal(record.outcome, 'up-to-date')
    assert.equal(t.requests[0].url, MANIFEST_URL)
    assert.deepEqual(t.downloads, [])
    assert.deepEqual(t.getSaved(), { etag: '"v1"', lastCheck: record, manifest: CURRENT })
  })

  it('downloads, verifies, installs and offers a reload for a newer release', async () => {
    const t = await setup([manifestResponse(NEWER)])
    const record = await t.updater.check()
    const vsixPath = join(t.storageDir, 'updates', NEWER.vsix)
    assert.equal(record.outcome, 'installed')
    assert.deepEqual(
      t.downloads.map(({ dest, expectedSha256, url }) => ({ dest, expectedSha256, url })),
      [{ dest: vsixPath, expectedSha256: NEWER.sha256, url: `${RELEASES_URL}/download/v0.2.0/${NEWER.vsix}` }],
    )
    assert.deepEqual(t.installs, [vsixPath])
    assert.deepEqual(t.installed, ['0.2.0'])
    await assert.rejects(stat(vsixPath), { code: 'ENOENT' }) // not kept once installed
  })

  it('sends the cached ETag and uses the cached manifest on a 304', async () => {
    const t = await setup([{ status: 304 }])
    t.setSaved({ etag: '"v1"', manifest: CURRENT })
    const record = await t.updater.check()
    assert.deepEqual(t.requests[0].headers, { 'If-None-Match': '"v1"' })
    assert.equal(record.outcome, 'up-to-date')
  })

  it('installs an older stable release, so a rollback reaches every copy', async () => {
    const older = { ...CURRENT, version: '0.0.9', vsix: 'oregan-policy-manager-0.0.9.vsix' }
    const t = await setup([manifestResponse(older)])
    const record = await t.updater.check()
    assert.equal(record.outcome, 'installed')
    assert.deepEqual(
      t.downloads.map(({ url }) => url),
      [`${RELEASES_URL}/download/v0.0.9/${older.vsix}`],
    )
    assert.deepEqual(t.installed, ['0.0.9'])
  })

  it('fails safe on a malformed manifest and keeps the previous cache', async () => {
    const t = await setup([{ body: Buffer.from('<html>'), etag: '"bad"', status: 200 }])
    t.setSaved({ etag: '"v1"', manifest: CURRENT })
    const record = await t.updater.check()
    assert.equal(record.outcome, 'failed')
    assert.match(record.detail, /not valid JSON/)
    assert.deepEqual(t.getSaved(), { etag: '"v1"', lastCheck: record, manifest: CURRENT })
    assert.ok(t.logger.lines.some(line => line.startsWith('error: Update check failed')))
  })

  it('does not install when the download fails verification', async () => {
    const t = await setup([manifestResponse(NEWER)], {
      async download() {
        throw new Error('SHA-256 mismatch: expected aaa, got bbb')
      },
    })
    const record = await t.updater.check()
    assert.equal(record.outcome, 'failed')
    assert.deepEqual(t.installs, [])
    assert.deepEqual(t.installed, [])
  })

  it('reports a failed install without offering a reload', async () => {
    const t = await setup([manifestResponse(NEWER)], {
      async install() {
        throw new Error('install refused')
      },
    })
    assert.equal((await t.updater.check()).outcome, 'failed')
    assert.deepEqual(t.installed, [])
  })

  it('does not install the same release twice while waiting for a reload', async () => {
    const t = await setup([manifestResponse(NEWER), manifestResponse(NEWER, '"v2"')])
    await t.updater.check()
    const second = await t.updater.check({ force: true })
    assert.equal(second.outcome, 'up-to-date')
    assert.match(second.detail, /waiting for a window reload/)
    assert.equal(t.installs.length, 1)
  })

  it('skips the cycle another window has taken, unless forced', async () => {
    const t = await setup([manifestResponse(CURRENT), manifestResponse(CURRENT)])
    const first = await t.updater.check()
    const skipped = await t.updater.check()
    assert.equal(skipped.outcome, 'skipped')
    assert.equal(t.requests.length, 1)
    assert.deepEqual(t.getSaved().lastCheck, first) // a skipped cycle isn't recorded
    await t.updater.check({ force: true })
    assert.equal(t.requests.length, 2)
  })

  it('shares one check between overlapping calls', async () => {
    const t = await setup([manifestResponse(CURRENT)])
    const [a, b] = await Promise.all([t.updater.check(), t.updater.check({ force: true })])
    assert.equal(a, b)
    assert.equal(t.requests.length, 1)
  })
})

describe('scheduleChecks', () => {
  /** Timers that record what was scheduled instead of running it */
  function createFakeTimers() {
    const scheduled: Array<{ callback: () => void; cleared: boolean; ms: number }> = []
    const timers: TimerApi = {
      clearTimeout(handle) {
        ;(handle as { cleared: boolean }).cleared = true
      },
      setTimeout(callback, ms) {
        const entry = { callback, cleared: false, ms }
        scheduled.push(entry)
        return entry
      },
    }
    return { scheduled, timers }
  }

  const flush = () => new Promise(resolve => setImmediate(resolve))

  it('checks straight away, then after the interval plus jitter each time', async () => {
    const { scheduled, timers } = createFakeTimers()
    let checks = 0
    const options = { intervalMs: 1000, jitterMs: 100, logger: createFakeLogger(), random: () => 0.5, timers }
    const schedule = scheduleChecks({
      ...options,
      async check() {
        checks++
      },
    })
    await flush()
    assert.equal(checks, 1)
    assert.deepEqual(
      scheduled.map(entry => entry.ms),
      [1050],
    )
    scheduled[0].callback()
    await flush()
    assert.equal(checks, 2)
    assert.equal(scheduled.length, 2)
    schedule.dispose()
    assert.equal(scheduled[1].cleared, true)
  })

  it('keeps scheduling after a check throws, and logs it', async () => {
    const { scheduled, timers } = createFakeTimers()
    const logger = createFakeLogger()
    scheduleChecks({
      async check() {
        throw new Error('boom')
      },
      logger,
      timers,
    })
    await flush()
    assert.equal(scheduled.length, 1)
    assert.ok(logger.lines.includes('error: Update check threw: boom'))
  })

  it('schedules nothing more once disposed, even if a check was in flight', async () => {
    const { scheduled, timers } = createFakeTimers()
    let finish: () => void = () => undefined
    const schedule = scheduleChecks({
      check: () =>
        new Promise<void>(resolve => {
          finish = resolve
        }),
      logger: createFakeLogger(),
      timers,
    })
    schedule.dispose()
    finish()
    await flush()
    assert.equal(scheduled.length, 0)
  })
})
