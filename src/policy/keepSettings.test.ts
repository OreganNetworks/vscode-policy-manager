import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBurstGuard, createDriftHandler } from './keepSettings'
import { MANAGED_SETTINGS, type SettingInspection } from './settings'
import { createFakeLogger } from '../testing/fakeLogger'
import { createFakeStore, stockEntries } from '../testing/fakeSettingsStore'

describe('createBurstGuard', () => {
  it('allows up to the limit inside the window, then suspends the key for the session', () => {
    const guard = createBurstGuard({ limit: 2, windowMs: 1000 })
    assert.equal(guard.check('a', 0), 'allowed')
    assert.equal(guard.check('a', 100), 'allowed')
    assert.equal(guard.check('a', 200), 'suspended-now')
    assert.equal(guard.check('a', 5000), 'suspended')
    assert.equal(guard.check('b', 200), 'allowed')
  })

  it('forgets restores that fall outside the window', () => {
    const guard = createBurstGuard({ limit: 2, windowMs: 1000 })
    guard.check('a', 0)
    guard.check('a', 100)
    assert.equal(guard.check('a', 1500), 'allowed')
  })
})

describe('createDriftHandler', () => {
  const TELEMETRY = 'telemetry.telemetryLevel'
  const AI = 'chat.disableAIFeatures'
  const only = (key: string) => (changed: string) => changed === key

  /** Every managed key registered and already at its policy value */
  function compliantEntries(): Record<string, SettingInspection> {
    const entries = stockEntries()
    for (const { key, value } of MANAGED_SETTINGS) entries[key] = { ...entries[key], globalValue: value }
    return entries
  }

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
      guard: createBurstGuard({ limit: 2, windowMs: 10_000 }),
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
