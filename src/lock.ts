/*
 * Lock files in the global storage, which every window shares: the update check takes one for a cycle, and the
 * settings lock (`settingsLock.ts`) takes one for each pass that may write user settings.
 */
import { link, mkdir, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Arguments to {@link tryAcquireCycleLock} */
export type CycleLockOptions = {
  now: number
  /** Lock file, under the extension's `globalStorageUri` - shared by every window */
  path: string
  /** How long a taken lock keeps other windows off */
  ttlMs: number
  /** Whether a process runs, for a lock with a process ID; defaults to {@link isProcessRunning} */
  isRunning?: (pid: number) => boolean
  /**
   * The process taking the lock, written into it.  Given, a lock that holds the ID of a process that no longer runs is
   * taken over at once, however young.  The settings lock gives one, as a pass holds it only while its window runs;
   * the update check doesn't, as its lock keeps checks apart after its window has gone.
   */
  pid?: number
}

/**
 * Only one window checks for updates each cycle.  Every window runs its own timer; the first to create the lock
 * file does the check and the others skip that cycle.  The lock is never deleted after a check - it expires after
 * `ttlMs`, which is what keeps checks an interval apart across all windows.  Its age is its mtime, stamped with `now`.
 *
 * A lock older than `ttlMs`, stamped in the future, or held by a process that has gone (see `pid`), is moved aside by
 * {@link takeOverStaleLock} so this window can take it over.  If the move reveals the lock was actually still fresh -
 * another window took it in between this window's own staleness check and the move - it is put back and this window
 * skips the cycle instead.
 */
export async function tryAcquireCycleLock(options: CycleLockOptions): Promise<boolean> {
  const { now, path, pid } = options
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(path, 'wx')
      try {
        if (pid !== undefined) await file.writeFile(String(pid))
      } finally {
        await file.close()
      }
      await utimes(path, now / 1000, now / 1000)
      return true
    } catch (error: unknown) {
      if (!hasCode(error, 'EEXIST')) throw error
    }

    let stale: boolean
    try {
      stale = await isStale(path, options)
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) continue // another window just took it over - go round again
      throw error
    }
    if (!stale) return false

    if (!(await takeOverStaleLock(options))) return false
  }
  return false
}

/**
 * Move `path` aside and check whether the lock it moved was actually still fresh.  `rename` happens before that
 * check, so however many windows race here, each one moves a lock only once and checks the copy it moved itself -
 * there's no gap between another window's `stat` and its own take-over for a third window to land in.
 *
 * A lock that turns out to be fresh - taken by another window after this window's own staleness check but before
 * this `rename` - is put back with `link`, not `rename`, so it can't silently replace a lock a third window has since
 * taken; `EEXIST` on that `link` means a third window's lock is already there, which is left alone.  A lock that is
 * still stale is removed for good.
 */
export async function takeOverStaleLock(options: CycleLockOptions): Promise<boolean> {
  const { path } = options
  const stale = `${path}.${process.pid}.stale`
  try {
    await rename(path, stale)
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return true // another window already moved it - go round and try open() again
    throw error
  }
  if (!(await isStale(stale, options))) {
    try {
      await link(stale, path)
    } catch (error: unknown) {
      if (!hasCode(error, 'EEXIST')) throw error // a third window already holds a lock - leave it
    }
    await rm(stale, { force: true })
    return false
  }
  await rm(stale, { force: true })
  return true
}

/**
 * Whether a process with this ID runs on this machine.
 *
 * @param pid  The process ID.
 * @returns False only when the system says there is no such process.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM: it runs, as another user
    return !hasCode(error, 'ESRCH')
  }
}

/**
 * Whether the lock at `path` may be taken over: older than the TTL, stamped in the future, or, when the caller gives a
 * `pid`, held by a process that no longer runs.  A lock just created, before its process ID is written, reads as held.
 *
 * @param path     The lock file, or the copy moved aside.
 * @param options  The time and TTL, and the process ID of the caller when it writes one.
 * @returns True when the lock can be taken over.
 */
async function isStale(
  path: string,
  { isRunning = isProcessRunning, now, pid, ttlMs }: CycleLockOptions,
): Promise<boolean> {
  const { mtimeMs } = await stat(path)
  if (Math.abs(now - mtimeMs) >= ttlMs) return true
  if (pid === undefined) return false
  const holder = Number.parseInt(await readFile(path, 'utf8'), 10)
  return Number.isInteger(holder) && !isRunning(holder)
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
