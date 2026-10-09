import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Temporary folders for one spec file, removed together once its tests have run */
export type TempDirs = {
  /** A new empty folder in the system temporary folder, named `<prefix><random>` */
  make(): Promise<string>
  /** Removes every folder `make()` has returned */
  removeAll(): Promise<void>
}

/**
 * Temporary folders for a spec file.  Register `removeAll` once at the top of the file, so a run leaves nothing behind
 * in the system temporary folder.
 *
 * @param prefix  The start of each folder name, so a leftover one says which spec made it.
 * @returns The folders, made on demand.
 *
 * @example
 * const temp = createTempDirs('opm-lock-')
 * after(temp.removeAll)
 * const dir = await temp.make() // e.g. /tmp/opm-lock-Xa81Qz
 */
export function createTempDirs(prefix: string): TempDirs {
  const dirs: string[] = []
  return {
    async make() {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
    async removeAll() {
      await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
    },
  }
}
