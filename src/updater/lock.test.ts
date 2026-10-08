import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { takeOverStaleLock, tryAcquireCycleLock } from './lock'
import { createTempDirs } from '../testing/tempDirs'

const TTL = 60_000
const temp = createTempDirs('opm-lock-')
after(temp.removeAll)

/** A lock path under a directory that doesn't exist yet */
async function lockPath(): Promise<string> {
  return join(await temp.make(), 'globalStorage', 'update-check.lock')
}

describe('tryAcquireCycleLock', () => {
  it('lets the first window take the cycle and makes the others skip it', async () => {
    const path = await lockPath()
    assert.equal(await tryAcquireCycleLock({ now: 1_000_000, path, ttlMs: TTL }), true)
    assert.equal(await tryAcquireCycleLock({ now: 1_030_000, path, ttlMs: TTL }), false)
  })

  it('takes over a lock older than the TTL', async () => {
    const path = await lockPath()
    await tryAcquireCycleLock({ now: 1_000_000, path, ttlMs: TTL })
    assert.equal(await tryAcquireCycleLock({ now: 1_060_000, path, ttlMs: TTL }), true)
  })

  it('takes over a lock stamped in the future, e.g. after the clock moved back', async () => {
    const path = await lockPath()
    await tryAcquireCycleLock({ now: 9_000_000, path, ttlMs: TTL })
    assert.equal(await tryAcquireCycleLock({ now: 1_000_000, path, ttlMs: TTL }), true)
  })
})

describe('takeOverStaleLock', () => {
  it('puts back a lock another window has just taken', async () => {
    const path = await lockPath()
    await tryAcquireCycleLock({ now: 1_000_000, path, ttlMs: TTL })
    assert.equal(await takeOverStaleLock({ now: 1_001_000, path, ttlMs: TTL }), false)
    assert.equal((await stat(path)).mtimeMs, 1_000_000)
    assert.equal(await tryAcquireCycleLock({ now: 1_030_000, path, ttlMs: TTL }), false)
  })

  it('removes a lock older than the TTL', async () => {
    const path = await lockPath()
    await tryAcquireCycleLock({ now: 1_000_000, path, ttlMs: TTL })
    assert.equal(await takeOverStaleLock({ now: 1_060_000, path, ttlMs: TTL }), true)
    await assert.rejects(stat(path), { code: 'ENOENT' })
  })
})
