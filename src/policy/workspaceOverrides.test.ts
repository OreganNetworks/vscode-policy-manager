import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createOverrideWarning,
  findWorkspaceOverride,
  findWorkspaceOverrides,
  overrideMessage,
  overridesAi,
  type WorkspaceOverride,
} from './workspaceOverrides'
import { createFakeLogger } from '../testing/fakeLogger'
import { createFakeStore, stockEntries } from '../testing/fakeSettingsStore'

const AI = 'chat.disableAIFeatures'
const OVERRIDE: WorkspaceOverride = { key: AI, scope: 'workspace', value: false }

describe('findWorkspaceOverride', () => {
  it('finds a workspace value that disagrees with the policy, before a folder value', () => {
    assert.deepEqual(findWorkspaceOverride(true, { workspaceFolderValues: [false], workspaceValue: false }), {
      scope: 'workspace',
      value: false,
    })
    assert.deepEqual(findWorkspaceOverride(true, { workspaceFolderValues: [true, false], workspaceValue: true }), {
      scope: 'workspace folder',
      value: false,
    })
  })

  it('is undefined when the workspace and folder values agree, or there are none', () => {
    assert.equal(findWorkspaceOverride(true, { workspaceFolderValues: [true], workspaceValue: true }), undefined)
    assert.equal(findWorkspaceOverride(true, { globalValue: false }), undefined)
  })
})

describe('findWorkspaceOverrides', () => {
  it('lists the managed settings a workspace overrides, skipping unregistered ones', () => {
    const entries = stockEntries()
    entries[AI] = { ...entries[AI], workspaceValue: false }
    entries['github.copilot.enable'] = { ...entries['github.copilot.enable'], workspaceValue: { '*': false } }
    assert.deepEqual(findWorkspaceOverrides(createFakeStore(entries)), [OVERRIDE])
    const unregistered = { ...entries }
    delete unregistered[AI]
    assert.deepEqual(findWorkspaceOverrides(createFakeStore(unregistered)), [])
  })
})

describe('overridesAi', () => {
  it('is true for an override of an AI setting, and false for one of a telemetry setting', () => {
    assert.equal(overridesAi([OVERRIDE]), true)
    assert.equal(overridesAi([{ key: 'github.copilot.enable', scope: 'workspace folder', value: true }]), true)
    assert.equal(overridesAi([{ key: 'telemetry.telemetryLevel', scope: 'workspace', value: 'all' }]), false)
    assert.equal(overridesAi([]), false)
  })
})

describe('overrideMessage', () => {
  it('names the setting, its value and where it is set', () => {
    assert.equal(
      overrideMessage([OVERRIDE]),
      "Oregan Policy Manager: this workspace sets chat.disableAIFeatures to false in its workspace settings, against Oregan's Agentic AI Development Policy. Remove it from there; this message comes back until it is gone.",
    )
  })

  it('lists several', () => {
    const message = overrideMessage([
      OVERRIDE,
      { key: 'github.copilot.enable', scope: 'workspace folder', value: true },
    ])
    assert.match(message, /sets chat\.disableAIFeatures to false in its workspace settings and github\.copilot\.enable/)
    assert.match(message, /Remove them from there; this message comes back until they are gone\.$/)
  })
})

describe('createOverrideWarning', () => {
  /** A warning whose overrides and answers the spec controls */
  function harness(answers: ('closed' | 'opened-settings')[]) {
    let overrides: WorkspaceOverride[] = []
    const shown: number[] = []
    const slept: number[] = []
    let settle = () => {}
    const done = new Promise<void>(resolve => (settle = resolve))
    const logger = createFakeLogger()
    const warning = createOverrideWarning({
      find: () => overrides,
      logger,
      async show(found) {
        shown.push(found.length)
        return answers.shift() ?? 'closed'
      },
      async sleep(ms) {
        slept.push(ms)
        // The override goes once every answer has been used
        if (!answers.length) {
          overrides = []
          settle()
        }
      },
    })
    return {
      done,
      logger,
      set: (value: WorkspaceOverride[]) => (overrides = value),
      shown,
      slept,
      warning,
    }
  }

  it('shows the warning again each time it is closed while the override lasts', async () => {
    const h = harness(['closed', 'closed', 'closed'])
    h.set([OVERRIDE])
    h.warning.check()
    await h.done
    assert.deepEqual(h.shown, [1, 1, 1])
    assert.deepEqual(h.slept, [2000, 2000, 2000])
  })

  it('stays away longer after Open Workspace Settings', async () => {
    const h = harness(['opened-settings'])
    h.set([OVERRIDE])
    h.warning.check()
    await h.done
    assert.deepEqual(h.slept, [30_000])
  })

  it('shows nothing without an override, and one warning however often it is checked', async () => {
    const h = harness(['closed'])
    h.warning.check()
    assert.deepEqual(h.shown, [])
    h.set([OVERRIDE])
    h.warning.check()
    h.warning.check()
    await h.done
    assert.deepEqual(h.shown, [1])
  })

  it('logs the overrides once, and when they have gone', async () => {
    const h = harness(['closed'])
    h.set([OVERRIDE])
    h.warning.check()
    await h.done
    h.warning.check()
    assert.deepEqual(h.logger.lines, [
      'warn: Workspace overrides: chat.disableAIFeatures = false (workspace) - the extension never writes workspace settings',
      'info: Workspace overrides: none any more',
    ])
  })
})
