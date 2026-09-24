import { link, mkdir, open, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Arguments to {@link tryAcquireCycleLock} */
export type CycleLockOptions = {
  now: number
  /** Lock file, under the extension's `globalStorageUri` - shared by every window */
  path: string
  /** How long a taken lock keeps other windows off */
  ttlMs: number
}

/**
 * Only one window checks for updates each cycle.  Every window runs its own timer; the first to create the lock
 * file does the check and the others skip that cycle.  The lock is never deleted after a check - it expires after
 * `ttlMs`, which is what keeps checks an interval apart across all windows.  Its age is its mtime, stamped with `now`.
 *
 * A lock older than `ttlMs`, or stamped in the future, is moved aside by {@link takeOverStaleLock} so this window can
 * take it over.  If the move reveals the lock was actually still fresh - another window took it in between this
 * window's own staleness check and the move - it is put back and this window skips the cycle instead.
 */
export async function tryAcquireCycleLock({ now, path, ttlMs }: CycleLockOptions): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await (await open(path, 'wx')).close()
      await utimes(path, now / 1000, now / 1000)
      return true
    } catch (error: unknown) {
      if (!hasCode(error, 'EEXIST')) throw error
    }

    let mtimeMs: number
    try {
      ;({ mtimeMs } = await stat(path))
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) continue // another window just took it over - go round again
      throw error
    }
    if (Math.abs(now - mtimeMs) < ttlMs) return false

    if (!(await takeOverStaleLock({ now, path, ttlMs }))) return false
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
export async function takeOverStaleLock({ now, path, ttlMs }: CycleLockOptions): Promise<boolean> {
  const stale = `${path}.${process.pid}.stale`
  try {
    await rename(path, stale)
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return true // another window already moved it - go round and try open() again
    throw error
  }
  const { mtimeMs } = await stat(stale)
  if (Math.abs(now - mtimeMs) < ttlMs) {
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

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
