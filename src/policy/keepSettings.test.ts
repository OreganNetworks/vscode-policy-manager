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

  it('restores a drifted user value and reports it', async () => {
    const entries = compliantEntries()
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    const store = createFakeStore(entries)
    const restored: string[] = []
    const onChange = createDriftHandler({
      logger: createFakeLogger(),
      onFirstRestore: key => restored.push(key),
      store,
    })
    await onChange(only(TELEMETRY))
    assert.deepEqual(store.writes, [TELEMETRY])
    assert.equal(entries[TELEMETRY].globalValue, 'off')
    assert.deepEqual(restored, [TELEMETRY])
  })

  it('reports only the first restore of the session', async () => {
    const entries = compliantEntries()
    const store = createFakeStore(entries)
    const restored: string[] = []
    const onChange = createDriftHandler({
      logger: createFakeLogger(),
      onFirstRestore: key => restored.push(key),
      store,
    })
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    await onChange(only(TELEMETRY))
    entries[AI] = { defaultValue: false, globalValue: false }
    await onChange(only(AI))
    assert.deepEqual(store.writes, [TELEMETRY, AI])
    assert.deepEqual(restored, [TELEMETRY])
  })

  it('ignores keys the change did not touch', async () => {
    const entries = compliantEntries()
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    const store = createFakeStore(entries)
    await createDriftHandler({ logger: createFakeLogger(), onFirstRestore: () => undefined, store })(only(AI))
    assert.deepEqual(store.writes, [])
  })

  it('leaves a workspace override alone - workspace settings belong to the repository', async () => {
    const entries = compliantEntries()
    entries[AI] = { defaultValue: false, globalValue: true, workspaceValue: false }
    const store = createFakeStore(entries)
    await createDriftHandler({ logger: createFakeLogger(), onFirstRestore: () => undefined, store })(only(AI))
    assert.deepEqual(store.writes, [])
  })

  it('writes a key once an extension installed later registers it', async () => {
    const entries = compliantEntries()
    delete entries['redhat.telemetry.enabled']
    const store = createFakeStore(entries)
    const onChange = createDriftHandler({ logger: createFakeLogger(), onFirstRestore: () => undefined, store })
    await onChange(only('redhat.telemetry.enabled'))
    assert.deepEqual(store.writes, [])
    entries['redhat.telemetry.enabled'] = { defaultValue: null }
    await onChange(only('redhat.telemetry.enabled'))
    assert.deepEqual(store.writes, ['redhat.telemetry.enabled'])
  })

  it('does not report a restore whose write the editor refused', async () => {
    const entries = compliantEntries()
    entries[TELEMETRY] = { defaultValue: 'all', globalValue: 'all' }
    const store = createFakeStore(entries, [TELEMETRY])
    const restored: string[] = []
    const onChange = createDriftHandler({
      logger: createFakeLogger(),
      onFirstRestore: key => restored.push(key),
      store,
    })
    await onChange(only(TELEMETRY))
    assert.deepEqual(restored, [])
  })

  it('stops restoring a key another writer keeps changing, and says so once', async () => {
    const entries = compliantEntries()
    const logger = createFakeLogger()
    const store = createFakeStore(entries)
    const onChange = createDriftHandler({
      guard: createBurstGuard({ limit: 2, windowMs: 10_000 }),
      logger,
      now: () => 0,
      onFirstRestore: () => undefined,
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
