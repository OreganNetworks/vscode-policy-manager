/*
 * REQUIREMENT: Self-update
 *
 * Checks GitHub Releases on start-up and hourly, one window per cycle, and installs a newer release once its SHA-256
 * matches.  `manifest.ts`, `download.ts` and `lock.ts` are its parts.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadVerified, httpGet } from './download'
import { tryAcquireCycleLock } from './lock'
import { describeError, type Logger } from '../logger'
import { compareVersions, parseManifest, type ReleaseManifest } from './manifest'

/** GitHub Releases for this repository */
export const RELEASES_URL = 'https://github.com/OreganNetworks/vscode-policy-manager/releases'
/** A plain download URL rather than the REST API, so it isn't held to 60 requests an hour per IP */
export const MANIFEST_URL = `${RELEASES_URL}/latest/download/manifest.json`
export const CHECK_INTERVAL_MS = 60 * 60 * 1000 // hourly
export const CHECK_JITTER_MS = 5 * 60 * 1000 // up to 5 minutes on each interval

/*
 * Shorter than the interval, so a window's own next tick always finds its lock expired, but long enough that any
 * other window's tick inside the same hour finds it held.
 */
const LOCK_TTL_MS = CHECK_INTERVAL_MS - CHECK_JITTER_MS
const MANIFEST_MAX_BYTES = 64 * 1024 // a few hundred bytes in practice
const VSIX_MAX_BYTES = 50 * 1024 * 1024 // the VSIX is tens of KB; anything this size isn't ours
const REQUEST_TIMEOUT_MS = 30_000
const LOCK_FILE = 'update-check.lock'
const DOWNLOAD_DIR = 'updates'

/** How one update check ended */
export type UpdateOutcome = 'failed' | 'installed' | 'skipped' | 'up-to-date'

/** One update check, as the status report shows it */
export type UpdateCheckRecord = {
  /** Epoch milliseconds */
  at: number
  detail: string
  outcome: UpdateOutcome
  latestVersion?: string
}

/** Persisted in `globalState` between sessions, so an unchanged manifest can be answered with a 304 */
export type UpdaterCache = {
  etag?: string
  lastCheck?: UpdateCheckRecord
  /** The manifest the ETag belongs to */
  manifest?: ReleaseManifest
}

/** Port over `ExtensionContext.globalState` */
export type UpdaterCacheStore = {
  get(): UpdaterCache
  set(value: UpdaterCache): Promise<void>
}

/** Arguments to {@link createUpdater} */
export type UpdaterOptions = {
  cache: UpdaterCacheStore
  /** The running extension's version */
  currentVersion: string
  /** `workbench.extensions.installExtension` with the VSIX file */
  install: (vsixPath: string) => Promise<void>
  logger: Logger
  /** Offers the **Reload Window** button */
  onInstalled: (version: string) => void
  /** `ExtensionContext.globalStorageUri`, shared by every window */
  storageDir: string
  download?: typeof downloadVerified
  http?: typeof httpGet
  now?: () => number
}

/** Arguments to {@link Updater.check} */
export type CheckOptions = {
  /** Skip the single-window lock - used by the `Oregan: Check for Updates` command */
  force?: boolean
}

/** See {@link createUpdater} */
export type Updater = {
  /** Never rejects - a failure comes back as a `failed` record */
  check(options?: CheckOptions): Promise<UpdateCheckRecord>
}

type ManifestFetch = {
  manifest: ReleaseManifest
  etag?: string
}

/**
 * Update check: fetch `manifest.json`, and when it names a newer version, download the VSIX, verify its SHA-256
 * and install it.  Any failure is logged and recorded, and the running version carries on until the next check.
 *
 * Overlapping calls share one check.  The cache only moves forward on a check that completes, so a malformed
 * manifest can't leave behind an ETag that would hide the next good one.
 */
export function createUpdater({
  cache,
  currentVersion,
  download = downloadVerified,
  http = httpGet,
  install,
  logger,
  now = Date.now,
  onInstalled,
  storageDir,
}: UpdaterOptions): Updater {
  let inFlight: Promise<UpdateCheckRecord> | undefined
  /*
   * A version installed this session that is waiting for a reload.  The running code still reports the old version,
   * so without this every later check would download and install the same release again.
   */
  let installedVersion: string | undefined

  async function fetchManifest(previous: UpdaterCache): Promise<ManifestFetch> {
    const headers: Record<string, string> = previous.etag && previous.manifest ? { 'If-None-Match': previous.etag } : {}
    const response = await http({
      headers,
      maxBytes: MANIFEST_MAX_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
      url: MANIFEST_URL,
    })
    if (response.status === 304) {
      if (!previous.manifest) throw new Error('HTTP 304 for manifest.json without a cached copy')
      return { etag: previous.etag, manifest: previous.manifest }
    }
    return { etag: response.etag, manifest: parseManifest(response.body.toString('utf8')) }
  }

  async function applyManifest({ sha256, version, vsix }: ReleaseManifest, at: number): Promise<UpdateCheckRecord> {
    if (compareVersions(version, currentVersion) <= 0) {
      logger.debug(`Update check: ${currentVersion} is current (latest release ${version})`)
      return { at, detail: `up to date (${currentVersion})`, latestVersion: version, outcome: 'up-to-date' }
    }
    if (version === installedVersion)
      return {
        at,
        detail: `${version} installed, waiting for a window reload`,
        latestVersion: version,
        outcome: 'up-to-date',
      }

    const vsixPath = join(storageDir, DOWNLOAD_DIR, vsix)
    logger.info(`Update check: downloading ${version}`)
    await download({
      dest: vsixPath,
      expectedSha256: sha256,
      maxBytes: VSIX_MAX_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
      url: `${RELEASES_URL}/download/v${version}/${vsix}`,
    })
    try {
      await install(vsixPath)
    } finally {
      await rm(vsixPath, { force: true }) // installed or not, the VSIX isn't needed again
    }
    installedVersion = version
    logger.info(`Update check: installed ${version}`)
    onInstalled(version)
    return { at, detail: `installed ${version}`, latestVersion: version, outcome: 'installed' }
  }

  async function runCheck({ force = false }: CheckOptions): Promise<UpdateCheckRecord> {
    const at = now()
    const previous = cache.get()
    let record: UpdateCheckRecord
    let next: UpdaterCache
    try {
      const acquired =
        force || (await tryAcquireCycleLock({ now: at, path: join(storageDir, LOCK_FILE), ttlMs: LOCK_TTL_MS }))
      if (!acquired) {
        logger.debug('Update check: another window has this cycle, skipped')
        return { at, detail: 'another window has this cycle', outcome: 'skipped' }
      }
      const { etag, manifest } = await fetchManifest(previous)
      record = await applyManifest(manifest, at)
      next = { etag, manifest }
    } catch (error: unknown) {
      const message = describeError(error)
      logger.error(`Update check failed: ${message} - staying on ${currentVersion}, trying again at the next check`)
      record = { at, detail: message, outcome: 'failed' }
      next = { etag: previous.etag, manifest: previous.manifest }
    }
    try {
      await cache.set({ ...next, lastCheck: record })
    } catch (error: unknown) {
      logger.warn(`Update check: could not save state - ${describeError(error)} (ignored)`)
    }
    return record
  }

  return {
    check(options = {}) {
      inFlight ??= runCheck(options).finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}

/** The timer surface {@link scheduleChecks} uses; specs pass a fake */
export type TimerApi = {
  clearTimeout(handle: unknown): void
  setTimeout(callback: () => void, ms: number): unknown
}

/** Arguments to {@link scheduleChecks} */
export type ScheduleOptions = {
  check: () => Promise<unknown>
  logger: Logger
  intervalMs?: number
  jitterMs?: number
  random?: () => number
  timers?: TimerApi
}

const NODE_TIMERS: TimerApi = {
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
}

/**
 * Run `check` now, then again every `intervalMs` plus up to `jitterMs`.  A chain of `setTimeout` rather than
 * `setInterval`, so every interval gets its own jitter.  `extension.ts` puts the result in `context.subscriptions`,
 * which disposes it on deactivate.
 */
export function scheduleChecks({
  check,
  intervalMs = CHECK_INTERVAL_MS,
  jitterMs = CHECK_JITTER_MS,
  logger,
  random = Math.random,
  timers = NODE_TIMERS,
}: ScheduleOptions): { dispose(): void } {
  let handle: unknown
  let disposed = false

  function tick(): void {
    check()
      .catch((error: unknown) => logger.error(`Update check threw: ${describeError(error)}`))
      .finally(function scheduleNext() {
        if (disposed) return
        handle = timers.setTimeout(tick, intervalMs + Math.floor(random() * jitterMs))
      })
  }

  tick()
  return {
    dispose() {
      disposed = true
      if (handle !== undefined) timers.clearTimeout(handle)
    },
  }
}
