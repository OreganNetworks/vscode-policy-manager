import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyPolicy,
  type ApplyResult,
  findAiSettingsOutOfLine,
  findSwitchedOffAiSettings,
  isRegistered,
  isSettingEqual,
  MANAGED_SETTINGS,
} from './settings'
import { createFakeLogger } from '../testing/fakeLogger'
import { createFakeStore, stockEntries } from '../testing/fakeSettingsStore'

describe('isSettingEqual', () => {
  it('compares primitives strictly', () => {
    assert.equal(isSettingEqual('off', 'off'), true)
    assert.equal(isSettingEqual(false, 0), false)
    assert.equal(isSettingEqual(null, undefined), false)
  })

  it('compares objects by content, ignoring key order', () => {
    assert.equal(isSettingEqual({ '*': false, markdown: true }, { markdown: true, '*': false }), true)
    assert.equal(isSettingEqual({ '*': false }, { '*': false, markdown: true }), false)
    assert.equal(isSettingEqual({ a: { b: 1 } }, { a: { b: 2 } }), false)
  })

  it('compares arrays by position', () => {
    assert.equal(isSettingEqual([1, 2], [1, 2]), true)
    assert.equal(isSettingEqual([1, 2], [2, 1]), false)
    assert.equal(isSettingEqual([], {}), false)
  })
})

describe('isRegistered', () => {
  it('treats a key with a default as registered, including a null default', () => {
    assert.equal(isRegistered({ defaultValue: 'all' }), true)
    assert.equal(isRegistered({ defaultValue: null }), true)
  })

  it('treats a missing inspection, or one without a default, as unregistered', () => {
    assert.equal(isRegistered(undefined), false)
    assert.equal(isRegistered({ globalValue: true }), false)
  })
})

describe('applyPolicy', () => {
  it('writes every managed setting at user level, in table order', async () => {
    const store = createFakeStore(stockEntries())
    const results = await applyPolicy({ logger: createFakeLogger(), store })
    assert.deepEqual(
      store.writes,
      MANAGED_SETTINGS.map(setting => setting.key),
    )
    assert.deepEqual(store.entries['github.copilot.enable'].globalValue, { '*': false })
    assert.ok(results.every(result => result.state === 'applied'))
  })

  it('leaves a setting that already has the policy value', async () => {
    const entries = stockEntries()
    entries['telemetry.telemetryLevel'] = { defaultValue: 'all', globalValue: 'off' }
    const store = createFakeStore(entries)
    const results = await applyPolicy({ logger: createFakeLogger(), store })
    assert.ok(!store.writes.includes('telemetry.telemetryLevel'))
    assert.equal(results.find(result => result.key === 'telemetry.telemetryLevel')?.state, 'unchanged')
  })

  it('skips keys this editor has not registered, and says so', async () => {
    const entries = stockEntries()
    delete entries['redhat.telemetry.enabled']
    entries['chat.disableAIFeatures'] = {}
    const logger = createFakeLogger()
    const store = createFakeStore(entries)
    const results = await applyPolicy({ logger, store })
    assert.deepEqual(store.writes, ['telemetry.telemetryLevel', 'github.copilot.enable'])
    assert.equal(results.filter(result => result.state === 'unregistered').length, 2)
    assert.ok(logger.lines.includes('info: redhat.telemetry.enabled: not registered in this editor, skipped'))
  })

  it('carries on past a write the editor refuses, and reports it', async () => {
    const logger = createFakeLogger()
    const store = createFakeStore(stockEntries(), ['telemetry.telemetryLevel'])
    const results = await applyPolicy({ logger, store })
    const failed = results.find(result => result.key === 'telemetry.telemetryLevel')
    assert.equal(failed?.state, 'failed')
    assert.match(failed?.error ?? '', /configured in system policy/)
    assert.deepEqual(store.writes, ['redhat.telemetry.enabled', 'chat.disableAIFeatures', 'github.copilot.enable'])
    assert.ok(logger.lines.some(line => line.startsWith('warn: telemetry.telemetryLevel: could not be written')))
  })

  it('counts a refused write as unchanged when device policy already enforces the policy value', async () => {
    const entries = stockEntries()
    // Under device policy the editor reports the policy's value as the default and as the effective value
    entries['telemetry.telemetryLevel'] = { defaultValue: 'off', effectiveValue: 'off' }
    const logger = createFakeLogger()
    const store = createFakeStore(entries, ['telemetry.telemetryLevel'])
    const results = await applyPolicy({ logger, store })
    assert.deepEqual(
      results.find(result => result.key === 'telemetry.telemetryLevel'),
      { key: 'telemetry.telemetryLevel', state: 'unchanged' },
    )
    assert.ok(logger.lines.includes('info: telemetry.telemetryLevel: already enforced by device policy'))
    assert.ok(!logger.lines.some(line => line.startsWith('warn:')))
  })

  it('writes the user value even when a workspace value already matches the policy', async () => {
    const entries = stockEntries()
    entries['chat.disableAIFeatures'] = { defaultValue: false, workspaceValue: true }
    const store = createFakeStore(entries)
    await applyPolicy({ logger: createFakeLogger(), store })
    assert.ok(store.writes.includes('chat.disableAIFeatures'))
  })
})

describe('findSwitchedOffAiSettings', () => {
  it('lists the AI settings the apply wrote, and no telemetry setting', () => {
    const results: ApplyResult[] = [
      { key: 'telemetry.telemetryLevel', state: 'applied' },
      { key: 'chat.disableAIFeatures', state: 'applied' },
      { key: 'github.copilot.enable', state: 'applied' },
    ]
    assert.deepEqual(findSwitchedOffAiSettings(results), ['chat.disableAIFeatures', 'github.copilot.enable'])
  })

  it('leaves out an AI setting that was already in line, unregistered or refused', () => {
    const results: ApplyResult[] = [
      { key: 'chat.disableAIFeatures', state: 'unchanged' },
      { key: 'github.copilot.enable', state: 'unregistered' },
      { error: 'locked', key: 'chat.disableAIFeatures', state: 'failed' },
    ]
    assert.deepEqual(findSwitchedOffAiSettings(results), [])
  })
})

describe('findAiSettingsOutOfLine', () => {
  it('lists the registered AI settings whose user value is not the policy value', () => {
    const entries = stockEntries()
    entries['github.copilot.enable'] = { ...entries['github.copilot.enable'], globalValue: { '*': false } }
    entries['telemetry.telemetryLevel'] = { ...entries['telemetry.telemetryLevel'], globalValue: 'all' }
    delete entries['redhat.telemetry.enabled']
    assert.deepEqual(findAiSettingsOutOfLine(createFakeStore(entries)), ['chat.disableAIFeatures'])
  })

  it('leaves out an AI setting this editor has not registered', () => {
    const entries = stockEntries()
    delete entries['chat.disableAIFeatures']
    assert.deepEqual(findAiSettingsOutOfLine(createFakeStore(entries)), ['github.copilot.enable'])
  })
})
