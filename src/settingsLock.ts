/*
 * One window at a time writes user settings.  Every window runs this extension, and they all react to the same
 * moments: start-up, the moment the extension applies itself to all profiles (it starts in every open window at once),
 * and a managed setting drifting.  Writing together, they refuse each other's writes: the editor turns a write away
 * when another window has saved `settings.json` since it loaded it ("the content of the file is newer"), and keeps the
 * refused edit in that window as unsaved changes, which the developer meets later as a save conflict.
 *
 * So each pass that may write user settings runs under a lock file in the global storage, which every window shares
 * once the extension is applied to all profiles.  A pass reads the settings again once it holds the lock, so a window
 * that waited finds the work done and writes nothing.  A pass that wrote holds the lock a little longer, for the other
 * windows to reload `settings.json` before they read it.
 */
import { rm, stat } from 'node:fs/promises'
import { tryAcquireCycleLock } from './lock'
import { describeError, type Logger } from './logger'
import { type SettingsStore } from './policy/settings'

/** Arguments to {@link createSettingsLock} */
export type SettingsLockOptions = {
  logger: Logger
  /** The lock file, under the extension's `globalStorageUri` */
  path: string
  /** How often a waiting window tries the lock */
  pollMs?: number
  /** How long a pass that wrote keeps the lock, for the other windows to reload `settings.json` */
  settleMs?: number
  /** A lock older than this was left by a window that went away during a pass, and is taken over */
  staleMs?: number
  /** How long a window waits for the lock before it runs its pass without it */
  timeoutMs?: number
}

/** The lock for one window: see {@link createSettingsLock} */
export type SettingsLock = {
  /**
   * Runs `pass` once this window holds the lock, after any pass of this window already waiting for it.
   *
   * @param what  Names the pass in the output channel.
   * @param pass  Reads the settings it needs and writes through a store from {@link SettingsLock.track}.
   * @returns What `pass` returns.
   */
  run<T>(what: string, pass: () => Promise<T>): Promise<T>
  /**
   * A store that writes through `store` and notes each write, so a pass that wrote holds the lock to settle.
   *
   * @param store  The user settings.
   * @returns The same settings, with writes noted.
   */
  track(store: SettingsStore): SettingsStore
  /** Removes the lock if this window holds it, for when the extension is deactivated */
  dispose(): Promise<void>
}

const POLL_MS = 200
const SETTLE_MS = 2_000 // the editor reloads settings.json from disk well within this
const STALE_MS = 15_000 // a pass takes a write or two plus the settle
const TIMEOUT_MS = 20_000 // longer than STALE_MS, so a lock left behind is taken over before a window gives up

/**
 * The settings lock for one window.
 *
 * @param options  Where the lock file is, and the timings.
 * @returns The lock.
 *
 * @example
 * const lock = createSettingsLock({ logger, path: join(context.globalStorageUri.fsPath, 'settings-write.lock') })
 * const store = lock.track(createSettingsStore())
 * await lock.run('Start-up', () => applyPolicy({ logger, store }))
 */
export function createSettingsLock({
  logger,
  path,
  pollMs = POLL_MS,
  settleMs = SETTLE_MS,
  staleMs = STALE_MS,
  timeoutMs = TIMEOUT_MS,
}: SettingsLockOptions): SettingsLock {
  let queue: Promise<unknown> = Promise.resolve()
  /** The mtime this window stamped on the lock it holds, which tells its own lock from a later one */
  let heldStamp: number | undefined
  let wrote = false

  async function acquire(what: string): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const now = Date.now()
      try {
        if (await tryAcquireCycleLock({ now, path, ttlMs: staleMs })) {
          heldStamp = now
          return true
        }
      } catch (error: unknown) {
        logger.warn(`${what}: could not take the settings lock - ${describeError(error)}; going ahead without it`)
        return false
      }
      if (now >= deadline) {
        logger.warn(`${what}: another window has held the settings lock for ${timeoutMs / 1000} s; going ahead`)
        return false
      }
      await sleep(pollMs)
    }
  }

  async function release(): Promise<void> {
    const stamp = heldStamp
    heldStamp = undefined
    if (stamp === undefined) return
    try {
      /*
       * A lock that another window took over, after this one held it past staleMs, is that window's to remove.  The
       * stamp reads back within a millisecond, not exactly: the Node.js of VS Code 1.90 rounds it on the way to disk.
       */
      if (Math.abs((await stat(path)).mtimeMs - stamp) < 1) await rm(path, { force: true })
    } catch (error: unknown) {
      if (!hasCode(error, 'ENOENT')) logger.warn(`Could not remove the settings lock - ${describeError(error)}`)
    }
  }

  async function locked<T>(what: string, pass: () => Promise<T>): Promise<T> {
    const held = await acquire(what)
    wrote = false
    try {
      return await pass()
    } finally {
      if (held && wrote) await sleep(settleMs)
      await release()
    }
  }

  return {
    run(what, pass) {
      const result = queue.then(() => locked(what, pass))
      queue = result.catch(() => undefined)
      return result
    },
    track(store) {
      return {
        inspect: key => store.inspect(key),
        async updateGlobal(key, value) {
          await store.updateGlobal(key, value)
          wrote = true
        },
      }
    },
    dispose: release,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
