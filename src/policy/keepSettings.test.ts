import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  admitStartUpRestores,
  createBurstGuard,
  createDriftHandler,
  createFileBurstStore,
  createMemoryBurstStore,
  DRIFT_BURST,
} from './keepSettings'
import { applyPolicy, MANAGED_SETTINGS, type SettingInspection } from './settings'
import { createFakeLogger } from '../testing/fakeLogger'
import { createFakeStore, stockEntries } from '../testing/fakeSettingsStore'
import { createTempDirs } from '../testing/tempDirs'

const temp = createTempDirs('opm-keep-settings-')
after(temp.removeAll)

const TELEMETRY = 'telemetry.telemetryLevel'
const AI = 'chat.disableAIFeatures'

/** Every managed key registered and already at its policy value */
function compliantEntries(): Record<string, SettingInspection> {
  const entries = stockEntries()
  for (const { key, value } of MANAGED_SETTINGS) entries[key] = { ...entries[key], globalValue: value }
  return entries
}

/** A count file under a folder that doesn't exist yet, as in a new global storage */
async function countPath(): Promise<string> {
  return join(await temp.make(), 'globalStorage', 'drift-restores.json')
}

describe('createBurstGuard', () => {
  const SHORT = { limit: 2, suspendMs: 60_000, windowMs: 1000 }

  it('allows up to the limit inside the window, then suspends the key for suspendMs', async () => {
    const guard = createBurstGuard(SHORT)
    assert.equal(await guard.check('a', 0), 'allowed')
    assert.equal(await guard.check('a', 100), 'allowed')
    assert.equal(await guard.check('a', 200), 'suspended-now')
    assert.equal(await guard.check('a', 5000), 'suspended')
    assert.equal(await guard.check('b', 200), 'allowed')
    assert.equal(await guard.check('a', 60_200), 'allowed')
  })

  it('forgets restores that fall outside the window', async () => {
    const guard = createBurstGuard(SHORT)
    await guard.check('a', 0)
    await guard.check('a', 100)
    assert.equal(await guard.check('a', 1500), 'allowed')
  })

  it('trips on restores 2 s apart, as the settings lock spaces them', async () => {
    const guard = createBurstGuard(DRIFT_BURST)
    const decisions = []
    for (let at = 0; at <= 10_000; at += 2000) decisions.push(await guard.check('a', at))
    assert.deepEqual(decisions, ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'suspended-now'])
  })

  it('carries the count over to a new guard on the same store, as after an extension host restart', async () => {
    const store = createMemoryBurstStore()
    await createBurstGuard({ ...SHORT, store }).check('a', 0)
    await createBurstGuard({ ...SHORT, store }).check('a', 100)
    assert.equal(await createBurstGuard({ ...SHORT, store }).check('a', 200), 'suspended-now')
    assert.equal(await createBurstGuard({ ...SHORT, store }).check('a', 300), 'suspended')
  })
})

describe('createFileBurstStore', () => {
  it('reads back the count it saved', async () => {
    const store = createFileBurstStore({ logger: createFakeLogger(), path: await countPath() })
    assert.equal(await store.get(), undefined)
    const state = { restores: { a: [1, 2] }, suspendedUntil: { b: 3 } }
    await store.set(state)
    assert.deepEqual(await store.get(), state)
  })

  it('reads a file that holds no count as no restores, and says so', async () => {
    const path = await countPath()
    await mkdir(dirname(path), { recursive: true })
    for (const content of ['{"restores": ', '{"restores": {"a": ["1"]}, "suspendedUntil": {}}']) {
      await writeFile(path, content)
      const logger = createFakeLogger()
      assert.equal(await createFileBurstStore({ logger, path }).get(), undefined)
      assert.equal(logger.lines.filter(line => line.startsWith('warn:')).length, 1, logger.lines.join('\n'))
    }
  })

  it('gives two windows one count, so a key one window suspends stays suspended in the other', async () => {
    const path = await countPath()
    const window = () =>
      createBurstGuard({
        limit: 2,
        store: createFileBurstStore({ logger: createFakeLogger(), path }),
        suspendMs: 60_000,
        windowMs: 1000,
      })
    const [first, second] = [window(), window()]
    assert.equal(await first.check('a', 0), 'allowed')
    assert.equal(await second.check('a', 100), 'allowed')
    assert.equal(await first.check('a', 200), 'suspended-now')
    assert.equal(await second.check('a', 300), 'suspended')
  })
})

describe('createDriftHandler', () => {
  const only = (key: string) => (changed: string) => changed === key

  /** Hooks that record their calls, with how many writes had happened by then */
  function recordingHooks(store: { writes: string[] }) {
    const events: string[] = []
    return {
      afterFirstRestore(key: string, restored: boolean) {
        events.push(`after ${key}: ${restored ? 'restored' : 'not restored'}`)
      },
      async beforeFirstRestore(key: string) {
        events.push(`before ${key}: ${store.writes.length} writes`)
      },
      events,
    }
  }

  const NO_HOOKS = { afterFirstRestore: () => undefined, beforeFirstRestore: async () => undefined }

  it('restores a drifted user value, with the first hook done before the write', async () => {
    const entries = compliantEntries()
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    const store = createFakeStore(entries)
    const hooks = recordingHooks(store)
    await createDriftHandler({ ...hooks, logger: createFakeLogger(), store })(only(TELEMETRY))
    assert.deepEqual(store.writes, [TELEMETRY])
    assert.equal(entries[TELEMETRY].globalValue, 'off')
    assert.deepEqual(hooks.events, [`before ${TELEMETRY}: 0 writes`, `after ${TELEMETRY}: restored`])
  })

  it('calls the hooks for the first restore of the session only', async () => {
    const entries = compliantEntries()
    const store = createFakeStore(entries)
    const hooks = recordingHooks(store)
    const onChange = createDriftHandler({ ...hooks, logger: createFakeLogger(), store })
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    await onChange(only(TELEMETRY))
    entries[AI] = { defaultValue: false, globalValue: false }
    await onChange(only(AI))
    assert.deepEqual(store.writes, [TELEMETRY, AI])
    assert.deepEqual(hooks.events, [`before ${TELEMETRY}: 0 writes`, `after ${TELEMETRY}: restored`])
  })

  it('ignores keys the change did not touch', async () => {
    const entries = compliantEntries()
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    const store = createFakeStore(entries)
    await createDriftHandler({ ...NO_HOOKS, logger: createFakeLogger(), store })(only(AI))
    assert.deepEqual(store.writes, [])
  })

  it('leaves a workspace override alone - workspace settings belong to the repository', async () => {
    const entries = compliantEntries()
    entries[AI] = { defaultValue: false, globalValue: true, workspaceValue: false }
    const store = createFakeStore(entries)
    await createDriftHandler({ ...NO_HOOKS, logger: createFakeLogger(), store })(only(AI))
    assert.deepEqual(store.writes, [])
  })

  it('writes a key once an extension installed later registers it', async () => {
    const entries = compliantEntries()
    delete entries['redhat.telemetry.enabled']
    const store = createFakeStore(entries)
    const onChange = createDriftHandler({ ...NO_HOOKS, logger: createFakeLogger(), store })
    await onChange(only('redhat.telemetry.enabled'))
    assert.deepEqual(store.writes, [])
    entries['redhat.telemetry.enabled'] = { defaultValue: null }
    await onChange(only('redhat.telemetry.enabled'))
    assert.deepEqual(store.writes, ['redhat.telemetry.enabled'])
  })

  it('says when the first write was refused, and treats the next restore as the first', async () => {
    const entries = compliantEntries()
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    const store = createFakeStore(entries, [TELEMETRY])
    const hooks = recordingHooks(store)
    const onChange = createDriftHandler({ ...hooks, logger: createFakeLogger(), store })
    await onChange(only(TELEMETRY))
    entries[AI] = { defaultValue: false, globalValue: false }
    await onChange(only(AI))
    assert.deepEqual(hooks.events, [
      `before ${TELEMETRY}: 0 writes`,
      `after ${TELEMETRY}: not restored`,
      `before ${AI}: 0 writes`,
      `after ${AI}: restored`,
    ])
  })

  it('stops restoring a key another writer keeps changing, and says so once', async () => {
    const entries = compliantEntries()
    const logger = createFakeLogger()
    const store = createFakeStore(entries)
    const onChange = createDriftHandler({
      guard: createBurstGuard({ limit: 2, suspendMs: 60_000, windowMs: 10_000 }),
      logger,
      now: () => 0,
      ...NO_HOOKS,
      store,
    })
    for (let round = 0; round < 4; round++) {
      entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
      await onChange(only(TELEMETRY))
    }
    assert.equal(store.writes.length, 2)
    assert.equal(logger.lines.filter(line => line.startsWith('error:')).length, 1)
  })
})

describe('admitStartUpRestores', () => {
  const SHORT = { limit: 2, suspendMs: 60_000, windowMs: 10_000 }
  const keys = (settings: readonly { key: string }[]) => settings.map(setting => setting.key)

  it('counts each key start-up is about to write, and leaves out one the guard has suspended', async () => {
    const entries = compliantEntries()
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    const logger = createFakeLogger()
    const guard = createBurstGuard(SHORT)
    const admit = (at: number) =>
      admitStartUpRestores({ guard, logger, now: () => at, store: createFakeStore(entries) })
    const all = keys(MANAGED_SETTINGS)
    assert.deepEqual(keys(await admit(0)), all)
    assert.deepEqual(keys(await admit(100)), all)
    const others = all.filter(key => key !== TELEMETRY)
    assert.deepEqual(keys(await admit(200)), others)
    assert.deepEqual(keys(await admit(300)), others)
    assert.deepEqual(
      logger.lines.map(line => line.split(':')[0]),
      ['error', 'info'],
      logger.lines.join('\n'),
    )
  })

  it('counts nothing when every key is in line', async () => {
    const counts = createMemoryBurstStore()
    const guard = createBurstGuard({ ...SHORT, store: counts })
    const admitted = await admitStartUpRestores({
      guard,
      logger: createFakeLogger(),
      store: createFakeStore(compliantEntries()),
    })
    assert.deepEqual(keys(admitted), keys(MANAGED_SETTINGS))
    assert.equal(await counts.get(), undefined)
  })

  it('shares the count with the drift handler, so a writer that keeps turning the AI on is stopped', async () => {
    // Each AI restore restarts the extension host, so the writer meets the drift handler and start-up in turn
    const entries = compliantEntries()
    const store = createFakeStore(entries)
    const guard = createBurstGuard(SHORT)
    const logger = createFakeLogger()
    const onChange = createDriftHandler({
      afterFirstRestore: () => undefined,
      beforeFirstRestore: async () => undefined,
      guard,
      logger,
      now: () => 0,
      store,
    })
    const turnAiOn = () => (entries[AI] = { defaultValue: false, globalValue: false })
    turnAiOn()
    await onChange(key => key === AI)
    turnAiOn()
    await applyPolicy({ logger, settings: await admitStartUpRestores({ guard, logger, now: () => 100, store }), store })
    turnAiOn()
    await onChange(key => key === AI)
    assert.deepEqual(store.writes, [AI, AI])
    assert.equal(entries[AI].globalValue, false)
  })
})
