import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { addMissingEntries, IGNORED_EXTENSIONS_KEY, IGNORED_SETTINGS_KEY, keepOutOfSync } from './keepOutOfSync'
import { createFakeLogger } from '../testing/fakeLogger'
import { createFakeStore } from '../testing/fakeSettingsStore'

describe('addMissingEntries', () => {
  it('appends the entries that are missing, after the ones the developer has', () => {
    assert.deepEqual(addMissingEntries(['editor.fontSize'], ['a', 'b']), ['editor.fontSize', 'a', 'b'])
    assert.deepEqual(addMissingEntries(['b'], ['a', 'b']), ['b', 'a'])
  })

  it('is undefined when nothing is missing, so nothing is written', () => {
    assert.equal(addMissingEntries(['a', 'b', 'c'], ['a', 'b']), undefined)
  })

  it('drops a "-" entry that would sync one of them, and starts from nothing when the value is not a list', () => {
    assert.deepEqual(addMissingEntries(['-a', 'editor.fontSize'], ['a']), ['editor.fontSize', 'a'])
    assert.deepEqual(addMissingEntries(undefined, ['a']), ['a'])
    assert.deepEqual(addMissingEntries('a', ['a']), ['a'])
  })

  it('compares case-insensitively when asked, as extension IDs are', () => {
    assert.equal(addMissingEntries(['GitHub.copilot'], ['github.copilot'], { ignoreCase: true }), undefined)
    assert.deepEqual(addMissingEntries(['GitHub.copilot'], ['github.copilot']), ['GitHub.copilot', 'github.copilot'])
  })
})

describe('keepOutOfSync', () => {
  const OPTIONS = { extensionIds: ['github.copilot', 'oregannetworks.oregan-policy-manager'], settingKeys: ['a', 'b'] }

  it('adds the managed settings and extensions to the two Settings Sync lists', async () => {
    const store = createFakeStore({
      [IGNORED_EXTENSIONS_KEY]: { defaultValue: [], globalValue: ['ms-python.python'] },
      [IGNORED_SETTINGS_KEY]: { defaultValue: [] },
    })
    await keepOutOfSync({ ...OPTIONS, logger: createFakeLogger(), store })
    assert.deepEqual(store.entries[IGNORED_SETTINGS_KEY].globalValue, ['a', 'b'])
    assert.deepEqual(store.entries[IGNORED_EXTENSIONS_KEY].globalValue, [
      'ms-python.python',
      'github.copilot',
      'oregannetworks.oregan-policy-manager',
    ])
  })

  it('writes nothing when both lists already have every entry', async () => {
    const store = createFakeStore({
      [IGNORED_EXTENSIONS_KEY]: {
        defaultValue: [],
        globalValue: ['GitHub.Copilot', 'oregannetworks.oregan-policy-manager'],
      },
      [IGNORED_SETTINGS_KEY]: { defaultValue: [], globalValue: ['b', 'a'] },
    })
    await keepOutOfSync({ ...OPTIONS, logger: createFakeLogger(), store })
    assert.deepEqual(store.writes, [])
  })

  it('skips an editor without Settings Sync, and says so', async () => {
    const store = createFakeStore({})
    const logger = createFakeLogger()
    await keepOutOfSync({ ...OPTIONS, logger, store })
    assert.deepEqual(store.writes, [])
    assert.ok(logger.lines.some(line => line.includes(IGNORED_SETTINGS_KEY) && line.includes('not registered')))
  })

  it('logs a refused write and carries on with the other list', async () => {
    const store = createFakeStore(
      { [IGNORED_EXTENSIONS_KEY]: { defaultValue: [] }, [IGNORED_SETTINGS_KEY]: { defaultValue: [] } },
      [IGNORED_SETTINGS_KEY],
    )
    const logger = createFakeLogger()
    await keepOutOfSync({ ...OPTIONS, logger, store })
    assert.deepEqual(store.writes, [IGNORED_EXTENSIONS_KEY])
    assert.ok(logger.lines.some(line => line.startsWith('warn:') && line.includes(IGNORED_SETTINGS_KEY)))
  })
})
