import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { applyToAllProfiles, readAppliedToAllProfiles } from './applyToAllProfiles'
import { createFakeLogger } from '../testing/fakeLogger'
import { createTempDirs } from '../testing/tempDirs'

const ID = 'oregannetworks.oregan-policy-manager'
const temp = createTempDirs('opm-profiles-')
after(temp.removeAll)

/** An `extensions.json` for the default profile with `entries`, in a fresh directory */
async function writeManifest(entries: unknown): Promise<string> {
  const path = join(await temp.make(), 'extensions.json')
  await writeFile(path, JSON.stringify(entries))
  return path
}

/** An entry as the editor writes it */
const entry = (id: string, metadata: object) => ({ identifier: { id }, metadata, version: '0.1.0' })

describe('readAppliedToAllProfiles', () => {
  it('is true for an entry with isApplicationScoped, matching the ID case-insensitively', async () => {
    const path = await writeManifest([entry('OreganNetworks.Oregan-Policy-Manager', { isApplicationScoped: true })])
    assert.equal(await readAppliedToAllProfiles(path, ID), true)
  })

  it('is false for an entry without it, and when the extension is not listed', async () => {
    assert.equal(await readAppliedToAllProfiles(await writeManifest([entry(ID, { pinned: true })]), ID), false)
    assert.equal(await readAppliedToAllProfiles(await writeManifest([entry('other.ext', {})]), ID), false)
  })

  it('cannot tell when the file is missing or not the list the editor writes', async () => {
    assert.equal(await readAppliedToAllProfiles(join(tmpdir(), 'no-such-dir', 'extensions.json'), ID), undefined)
    assert.equal(await readAppliedToAllProfiles(await writeManifest({ extensions: [] }), ID), undefined)
  })
})

describe('applyToAllProfiles', () => {
  type SetupOptions = {
    /** Toggles the editor ignores before one takes, the way 1.90 does until its extension list is loaded */
    ignored?: number
    /** The state reads as applied after this many reads, whatever the toggles do */
    appliedAfterReads?: number
    toggleFails?: boolean
  }

  /** Ports over a scope that `toggle` flips, the way the editor command does, with a sleep that only records */
  function setup(
    initial: boolean | undefined,
    { appliedAfterReads, ignored = 0, toggleFails = false }: SetupOptions = {},
  ) {
    let applied = initial
    let reads = 0
    let toggles = 0
    const sleeps: number[] = []
    const logger = createFakeLogger()
    const options = {
      async isApplied() {
        reads++
        if (appliedAfterReads !== undefined && reads > appliedAfterReads) applied = true
        return applied
      },
      logger,
      retryDelaysMs: [5_000, 30_000],
      async sleep(ms: number) {
        sleeps.push(ms)
      },
      async toggle() {
        toggles++
        if (toggleFails) throw new Error("command 'workbench.extensions.action.toggleApplyToAllProfiles' not found")
        if (toggles > ignored) applied = !applied
      },
    }
    return { logger, options, sleeps, toggles: () => toggles }
  }

  it('turns it on when it is off, and checks it took', async () => {
    const t = setup(false)
    assert.equal(await applyToAllProfiles(t.options), 'applied')
    assert.equal(t.toggles(), 1)
    assert.deepEqual(t.sleeps, [])
    assert.ok(t.logger.lines.some(line => line.startsWith('info: Applied to all profiles')))
  })

  it('tries again later when the editor ignores the toggle', async () => {
    const t = setup(false, { ignored: 1 })
    assert.equal(await applyToAllProfiles(t.options), 'applied')
    assert.equal(t.toggles(), 2)
    assert.deepEqual(t.sleeps, [5_000])
  })

  it('never toggles once the state reads as applied, which would turn it off', async () => {
    // The first toggle is ignored, but something else applies it before the retry
    const t = setup(false, { appliedAfterReads: 2, ignored: 1 })
    assert.equal(await applyToAllProfiles(t.options), 'applied')
    assert.equal(t.toggles(), 1)
  })

  it('never runs the toggle when it is already on', async () => {
    const t = setup(true)
    assert.equal(await applyToAllProfiles(t.options), 'already')
    assert.equal(t.toggles(), 0)
  })

  it('leaves it alone when the state cannot be read', async () => {
    const t = setup(undefined)
    assert.equal(await applyToAllProfiles(t.options), 'unknown')
    assert.equal(t.toggles(), 0)
  })

  it('logs and carries on when the editor has no such command', async () => {
    const t = setup(false, { toggleFails: true })
    assert.equal(await applyToAllProfiles(t.options), 'failed')
    assert.equal(t.toggles(), 1)
    assert.ok(t.logger.lines.some(line => line.startsWith('warn:') && line.includes('(ignored)')))
  })

  it('gives up after the last retry when no toggle takes effect', async () => {
    const t = setup(false, { ignored: 99 })
    assert.equal(await applyToAllProfiles(t.options), 'failed')
    assert.equal(t.toggles(), 3)
    assert.deepEqual(t.sleeps, [5_000, 30_000])
    assert.ok(t.logger.lines.some(line => line.startsWith('warn:') && line.includes('still')))
  })
})
