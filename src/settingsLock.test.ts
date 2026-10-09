import assert from 'node:assert/strict'
import { stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { keepOutOfSync, IGNORED_EXTENSIONS_KEY, IGNORED_SETTINGS_KEY } from './policy/keepOutOfSync'
import { applyPolicy, type SettingInspection, type SettingsStore } from './policy/settings'
import { createSettingsLock, type SettingsLockOptions } from './settingsLock'
import { createFakeLogger } from './testing/fakeLogger'
import { createFakeStore, stockEntries } from './testing/fakeSettingsStore'
import { createTempDirs } from './testing/tempDirs'

const temp = createTempDirs('opm-settings-lock-')
after(temp.removeAll)

/** Short enough for specs; the real ones are seconds */
const FAST = { pollMs: 5, settleMs: 80, staleMs: 10_000, timeoutMs: 5_000 }

async function lockPath(): Promise<string> {
  return join(await temp.make(), 'globalStorage', 'settings-write.lock')
}

/** A lock for one window, with the fast timings unless the spec gives others */
function windowLock(path: string, options: Partial<SettingsLockOptions> = {}) {
  const logger = createFakeLogger()
  return { lock: createSettingsLock({ ...FAST, logger, path, ...options }), logger }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('createSettingsLock', () => {
  it('runs one pass at a time across windows, and the next only once the one that wrote has settled', async () => {
    const path = await lockPath()
    const [first, second] = [windowLock(path).lock, windowLock(path).lock]
    const store = first.track(createFakeStore(stockEntries()))
    const times: Record<string, number> = {}
    const pass = (name: string, write: boolean) => async () => {
      times[`${name} start`] = Date.now()
      if (write) await store.updateGlobal('telemetry.telemetryLevel', 'off')
      await sleep(20)
      times[`${name} end`] = Date.now()
    }
    const firstRun = first.run('first', pass('first', true))
    await sleep(5) // the first window takes the lock
    await Promise.all([firstRun, second.run('second', pass('second', false))])
    assert.ok(times['second start'] >= times['first end'] + FAST.settleMs - 5, JSON.stringify(times))
  })

  it('lets the next pass start at once after a pass that wrote nothing', async () => {
    const path = await lockPath()
    const [first, second] = [windowLock(path).lock, windowLock(path).lock]
    const times: Record<string, number> = {}
    const firstRun = first.run('first', async () => {
      await sleep(20)
      times['first end'] = Date.now()
    })
    await sleep(5)
    await Promise.all([
      firstRun,
      second.run('second', async () => {
        times['second start'] = Date.now()
      }),
    ])
    assert.ok(times['second start'] - times['first end'] < FAST.settleMs, JSON.stringify(times))
  })

  it('runs the passes of one window in turn', async () => {
    const { lock } = windowLock(await lockPath())
    const order: string[] = []
    const pass = (name: string) => async () => {
      order.push(`${name} start`)
      await sleep(10)
      order.push(`${name} end`)
    }
    await Promise.all([lock.run('a', pass('a')), lock.run('b', pass('b'))])
    assert.deepEqual(order, ['a start', 'a end', 'b start', 'b end'])
  })

  it('removes the lock after a pass, and after a pass that failed', async () => {
    const path = await lockPath()
    const { lock } = windowLock(path)
    await lock.run('ok', async () => undefined)
    await assert.rejects(stat(path), { code: 'ENOENT' })
    await assert.rejects(
      lock.run('failing', async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    await assert.rejects(stat(path), { code: 'ENOENT' })
  })

  it('removes its own lock when the stamp reads back a fraction of a millisecond out, as in VS Code 1.90', async () => {
    const path = await lockPath()
    const { lock } = windowLock(path)
    await lock.run('rounded', async () => {
      const { mtimeMs } = await stat(path)
      await utimes(path, (mtimeMs + 0.4) / 1000, (mtimeMs + 0.4) / 1000)
    })
    await assert.rejects(stat(path), { code: 'ENOENT' })
  })

  it('takes over a lock that a window left behind', async () => {
    const path = await lockPath()
    const { lock } = windowLock(path, { staleMs: 1_000 })
    await windowLock(path).lock.run('setup', async () => undefined) // makes the folder
    await writeFile(path, '')
    const old = (Date.now() - 60_000) / 1000
    await utimes(path, old, old)
    const started = Date.now()
    await lock.run('takeover', async () => undefined)
    assert.ok(Date.now() - started < 500)
  })

  it('goes ahead without the lock after the timeout, and says so', async () => {
    const path = await lockPath()
    const holder = windowLock(path)
    const { lock, logger } = windowLock(path, { timeoutMs: 50 })
    let release = () => {}
    const held = holder.lock.run('holder', () => new Promise<void>(resolve => (release = resolve)))
    await sleep(5)
    let ran = false
    await lock.run('Start-up', async () => {
      ran = true
    })
    release()
    await held
    assert.equal(ran, true)
    assert.ok(
      logger.lines.some(line => line.startsWith('warn:') && line.includes('Start-up')),
      logger.lines.join('\n'),
    )
  })

  it('leaves a lock that another window took over while this one held it', async () => {
    const path = await lockPath()
    const { lock } = windowLock(path)
    await lock.run('slow', async () => {
      // Another window found this lock stale and took it over: a newer lock in its place
      const later = (Date.now() + 1_000) / 1000
      await utimes(path, later, later)
    })
    assert.ok((await stat(path)).isFile())
  })
})

/**
 * One `settings.json` and a view of it for each window, as the editor has: a window reads its own copy, which it
 * reloads `reloadMs` after another window saves the file, and a write from a copy older than the file is refused with
 * the error the editor gives.
 */
function sharedSettingsFile(entries: Record<string, SettingInspection>, reloadMs: number) {
  let file = { entries: structuredClone(entries), version: 0 }
  const views: { seen: typeof file }[] = []
  const writes: string[] = []
  const refused: string[] = []
  return {
    refused,
    view(): SettingsStore {
      const view = { seen: structuredClone(file) }
      views.push(view)
      return {
        inspect(key) {
          const entry = view.seen.entries[key]
          return entry && { effectiveValue: entry.globalValue ?? entry.defaultValue, ...entry }
        },
        async updateGlobal(key, value) {
          if (view.seen.version !== file.version) {
            refused.push(key)
            throw new Error('Unable to write into user settings because the content of the file is newer.')
          }
          file = {
            entries: { ...file.entries, [key]: { ...file.entries[key], globalValue: value } },
            version: file.version + 1,
          }
          writes.push(key)
          view.seen = structuredClone(file)
          const saved = structuredClone(file)
          for (const other of views)
            if (other !== view)
              setTimeout(() => {
                if (other.seen.version < saved.version) other.seen = saved
              }, reloadMs)
        },
      }
    },
    writes,
  }
}

describe('two windows starting together', () => {
  const entries = () => ({
    ...stockEntries(),
    [IGNORED_EXTENSIONS_KEY]: { defaultValue: [] },
    [IGNORED_SETTINGS_KEY]: { defaultValue: [] },
  })

  /** The settings part of start-up, in one window */
  async function startUp(store: SettingsStore): Promise<void> {
    const logger = createFakeLogger()
    await keepOutOfSync({ extensionIds: ['github.copilot'], logger, settingKeys: ['chat.disableAIFeatures'], store })
    await applyPolicy({ logger, store })
  }

  it("without the lock, refuse each other's writes", async () => {
    const file = sharedSettingsFile(entries(), 20)
    await Promise.all([startUp(file.view()), startUp(file.view())])
    assert.notDeepEqual(file.refused, [])
  })

  it('with the lock, write the policy and the Settings Sync lists once between them', async () => {
    const path = await lockPath()
    const file = sharedSettingsFile(entries(), 20)
    const window = () => {
      const { lock } = windowLock(path)
      const store = lock.track(file.view())
      return lock.run('Start-up', () => startUp(store))
    }
    await Promise.all([window(), window()])
    assert.deepEqual(file.refused, [])
    assert.deepEqual([...file.writes].sort(), [...new Set(file.writes)].sort())
    assert.ok(file.writes.includes('telemetry.telemetryLevel'))
    assert.ok(file.writes.includes(IGNORED_SETTINGS_KEY))
  })
})
