import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type InstalledExtension } from './policy/removeCopilotExtensions'
import { detectHost } from './host'
import { MANAGED_SETTINGS, type SettingInspection } from './policy/settings'
import { collectStatusSnapshot, describeSetting, formatStatusReport, isCompliant, type StatusSnapshot } from './status'

const AI_OFF = MANAGED_SETTINGS.find(setting => setting.key === 'chat.disableAIFeatures')!
const TELEMETRY = MANAGED_SETTINGS.find(setting => setting.key === 'telemetry.telemetryLevel')!

/*
 * Under device policy the editor reports the policy's value as the default and as the effective value, and refuses
 * a user write.  These are the inspections for telemetry locked to "off", and locked to "all" over a user "off".
 */
const LOCKED_OFF: SettingInspection = { defaultValue: 'off', effectiveValue: 'off' }
const LOCKED_ALL: SettingInspection = { defaultValue: 'all', effectiveValue: 'all', globalValue: 'off' }

/** A snapshot of a compliant VS Code machine; `overrides` replace whole fields */
function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    claudeCodeInstalled: true,
    editorVersion: '1.138.0',
    extensionVersion: '0.1.0',
    extensions: [{ builtIn: false, id: 'github.copilot', installed: false, pendingReload: false }],
    host: detectHost('Visual Studio Code'),
    settings: MANAGED_SETTINGS.map(setting =>
      describeSetting(setting, { defaultValue: null, effectiveValue: setting.value, globalValue: setting.value }),
    ),
    ...overrides,
  }
}

describe('describeSetting', () => {
  it('is compliant when the user value matches the policy', () => {
    assert.deepEqual(describeSetting(AI_OFF, { defaultValue: false, effectiveValue: true, globalValue: true }), {
      compliant: true,
      expected: true,
      global: true,
      key: 'chat.disableAIFeatures',
      registered: true,
    })
  })

  it('is not compliant when a workspace or folder value overrides it', () => {
    const workspace = describeSetting(AI_OFF, {
      defaultValue: false,
      effectiveValue: false,
      globalValue: true,
      workspaceValue: false,
    })
    assert.equal(workspace.compliant, false)
    assert.equal(workspace.overriddenBy, 'workspace')
    const folder = describeSetting(AI_OFF, {
      defaultValue: false,
      effectiveValue: true,
      globalValue: true,
      workspaceFolderValues: [true, false],
    })
    assert.equal(folder.compliant, false)
    assert.equal(folder.overriddenBy, 'workspace folder')
  })

  it('does not count a workspace value that agrees with the policy as an override', () => {
    const status = describeSetting(AI_OFF, {
      defaultValue: false,
      effectiveValue: true,
      globalValue: true,
      workspaceValue: true,
    })
    assert.equal(status.compliant, true)
    assert.equal(status.overriddenBy, undefined)
  })

  it('is compliant when device policy enforces the policy value, though the user value is unset', () => {
    const status = describeSetting(TELEMETRY, LOCKED_OFF)
    assert.equal(status.compliant, true)
    assert.equal(status.global, undefined)
  })

  it('judges the value in effect, not the user value', () => {
    assert.equal(describeSetting(TELEMETRY, LOCKED_ALL).compliant, false)
  })

  it('counts an unregistered key as compliant - there is nothing to switch off', () => {
    const status = describeSetting(AI_OFF, undefined)
    assert.equal(status.registered, false)
    assert.equal(status.compliant, true)
  })
})

describe('collectStatusSnapshot', () => {
  it('reads every managed setting and extension, and whether Claude Code is installed', () => {
    const installed: InstalledExtension[] = [
      { builtIn: true, dependencies: [], displayName: 'GitHub Copilot', id: 'GitHub.copilot-chat' },
      { builtIn: false, dependencies: [], displayName: 'Claude Code', id: 'Anthropic.claude-code' },
    ]
    const inspections: Record<string, SettingInspection> = {
      'telemetry.telemetryLevel': { defaultValue: 'all', effectiveValue: 'off', globalValue: 'off' },
    }
    const result = collectStatusSnapshot({
      editorVersion: '1.138.0',
      extensionVersion: '0.1.0',
      host: detectHost('Visual Studio Code'),
      registry: { list: () => installed },
      store: { inspect: key => inspections[key] },
    })
    assert.equal(result.claudeCodeInstalled, true)
    assert.equal(result.settings.length, MANAGED_SETTINGS.length)
    assert.deepEqual(
      result.extensions.find(extension => extension.id === 'github.copilot-chat'),
      { builtIn: true, id: 'github.copilot-chat', installed: true, pendingReload: false },
    )
    assert.equal(result.extensions.find(extension => extension.id === 'github.copilot')?.installed, false)
  })

  it('flags a managed extension the remover has uninstalled but the editor still runs', () => {
    const installed: InstalledExtension[] = [
      { builtIn: false, dependencies: [], displayName: 'GitHub Copilot', id: 'GitHub.copilot' },
    ]
    const result = collectStatusSnapshot({
      editorVersion: '1.138.0',
      extensionVersion: '0.1.0',
      host: detectHost('Visual Studio Code'),
      pendingReload: ['github.copilot'],
      registry: { list: () => installed },
      store: { inspect: () => undefined },
    })
    assert.deepEqual(
      result.extensions.find(extension => extension.id === 'github.copilot'),
      { builtIn: false, id: 'github.copilot', installed: true, pendingReload: true },
    )
    assert.equal(result.extensions.find(extension => extension.id === 'github.copilot-chat')?.pendingReload, false)
  })
})

describe('isCompliant', () => {
  it('passes a machine with every setting in line and no managed extension installed', () => {
    assert.equal(isCompliant(snapshot()), true)
  })

  it('fails a machine with a managed extension installed', () => {
    assert.equal(
      isCompliant(
        snapshot({ extensions: [{ builtIn: false, id: 'github.copilot', installed: true, pendingReload: false }] }),
      ),
      false,
    )
  })

  it('fails a machine with an uninstalled extension still running until a reload', () => {
    const extensions = [{ builtIn: false, id: 'github.copilot', installed: true, pendingReload: true }]
    assert.equal(isCompliant(snapshot({ extensions })), false)
  })

  it('passes a built-in Copilot Chat only while chat.disableAIFeatures is registered and on', () => {
    const extensions = [{ builtIn: true, id: 'github.copilot-chat', installed: true, pendingReload: false }]
    assert.equal(isCompliant(snapshot({ extensions })), true)
    const settings = snapshot().settings.map(status =>
      status.key === 'chat.disableAIFeatures'
        ? describeSetting(AI_OFF, { defaultValue: false, effectiveValue: false, globalValue: false })
        : status,
    )
    assert.equal(isCompliant(snapshot({ extensions, settings })), false)
  })
})

describe('formatStatusReport', () => {
  it('summarises a compliant machine', () => {
    const report = formatStatusReport(snapshot())
    assert.match(report, /^Oregan Policy Manager 0\.1\.0$/m)
    assert.match(report, /^Editor: VS Code 1\.138\.0 \(CLI `code`, extensions from Microsoft Marketplace\)$/m)
    assert.match(report, /^Overall: compliant$/m)
    assert.match(report, /^ {2}\[ok\] {3}telemetry\.telemetryLevel = "off"$/m)
    assert.match(report, /^ {2}\[ok\] {3}github\.copilot - not installed or disabled$/m)
    assert.match(report, /^Claude Code: installed$/m)
    assert.match(report, /^Last update check: not yet$/m)
  })

  it('names what is wrong on a non-compliant machine', () => {
    const settings = snapshot().settings.map(status =>
      status.key === 'chat.disableAIFeatures'
        ? describeSetting(AI_OFF, {
            defaultValue: false,
            effectiveValue: false,
            globalValue: true,
            workspaceValue: false,
          })
        : status,
    )
    const report = formatStatusReport(
      snapshot({
        claudeCodeInstalled: false,
        extensions: [{ builtIn: false, id: 'github.copilot', installed: true, pendingReload: false }],
        lastUpdateCheck: { at: Date.UTC(2026, 8, 23, 9, 0), detail: 'HTTP 404', outcome: 'failed' },
        settings,
      }),
    )
    assert.match(report, /^Overall: NOT compliant$/m)
    assert.match(report, /^ {2}\[FAIL\] chat\.disableAIFeatures = true, overridden by a workspace setting$/m)
    assert.match(report, /^ {2}\[FAIL\] github\.copilot - installed$/m)
    assert.match(report, /^Claude Code: not installed - run `code --install-extension anthropic\.claude-code`$/m)
    assert.match(report, /^Last update check: 2026-09-23T09:00:00\.000Z - failed: HTTP 404$/m)
  })

  it('shows the policy value next to a drifted one, and marks unregistered keys', () => {
    const settings = [
      describeSetting(AI_OFF, { defaultValue: false, effectiveValue: false, globalValue: false }),
      describeSetting(MANAGED_SETTINGS[1], undefined),
    ]
    const report = formatStatusReport(snapshot({ settings }))
    assert.match(report, /^ {2}\[FAIL\] chat\.disableAIFeatures = false \(policy: true\)$/m)
    assert.match(report, /^ {2}\[n\/a\] {2}redhat\.telemetry\.enabled - not registered in this editor$/m)
  })

  it('says when device policy, not the user value, keeps a setting in line', () => {
    const settings = snapshot().settings.map(status =>
      status.key === TELEMETRY.key ? describeSetting(TELEMETRY, LOCKED_OFF) : status,
    )
    const report = formatStatusReport(snapshot({ settings }))
    assert.match(report, /^Overall: compliant$/m)
    assert.match(report, /^ {2}\[ok\] {3}telemetry\.telemetryLevel = "off" \(set by device policy\)$/m)
  })

  it('names device policy when it overrides a user value that matches the policy', () => {
    const report = formatStatusReport(snapshot({ settings: [describeSetting(TELEMETRY, LOCKED_ALL)] }))
    assert.match(report, /^Overall: NOT compliant$/m)
    assert.match(report, /^ {2}\[FAIL\] telemetry\.telemetryLevel = "off", overridden by device policy$/m)
  })

  it('does not blame device policy for an object setting the editor merges over its default', () => {
    // The default from GitHub Copilot.  The editor merges the user value { "*": false } over it, so get() has every key
    const defaultValue = { '*': true, markdown: false, plaintext: false, scminput: false }
    const copilot = MANAGED_SETTINGS.find(setting => setting.key === 'github.copilot.enable')!
    const status = describeSetting(copilot, {
      defaultValue,
      effectiveValue: { ...defaultValue, '*': false },
      globalValue: { '*': false },
    })
    const report = formatStatusReport(snapshot({ settings: [status] }))
    assert.match(report, /^ {2}\[ok\] {3}github\.copilot\.enable = \{"\*":false\}$/m)
    assert.match(report, /^Overall: compliant$/m)
  })

  it('explains a built-in Copilot Chat', () => {
    const report = formatStatusReport(
      snapshot({ extensions: [{ builtIn: true, id: 'github.copilot-chat', installed: true, pendingReload: false }] }),
    )
    assert.match(report, /^ {2}\[ok\] {3}github\.copilot-chat - built in, switched off by chat\.disableAIFeatures$/m)
  })

  it('says when a built-in Copilot Chat is not switched off', () => {
    const report = formatStatusReport(
      snapshot({
        extensions: [{ builtIn: true, id: 'github.copilot-chat', installed: true, pendingReload: false }],
        settings: [describeSetting(AI_OFF, { defaultValue: false, effectiveValue: false, globalValue: false })],
      }),
    )
    assert.match(report, /^ {2}\[FAIL\] github\.copilot-chat - built in, and chat\.disableAIFeatures is not on$/m)
  })

  it('asks for a reload when all that is left is an uninstalled extension still running', () => {
    const report = formatStatusReport(
      snapshot({ extensions: [{ builtIn: false, id: 'github.copilot', installed: true, pendingReload: true }] }),
    )
    assert.match(report, /^Overall: reload the window to finish$/m)
    assert.match(report, /^ {2}\[wait\] github\.copilot - uninstalled, reload the window to finish$/m)
  })

  it('is NOT compliant when something besides a pending reload is wrong', () => {
    const report = formatStatusReport(
      snapshot({
        extensions: [
          { builtIn: false, id: 'github.copilot-chat', installed: true, pendingReload: false },
          { builtIn: false, id: 'github.copilot', installed: true, pendingReload: true },
        ],
      }),
    )
    assert.match(report, /^Overall: NOT compliant$/m)
    assert.match(report, /^ {2}\[FAIL\] github\.copilot-chat - installed$/m)
    assert.match(report, /^ {2}\[wait\] github\.copilot - uninstalled, reload the window to finish$/m)
  })

  it('adds a note for an AI-first editor', () => {
    assert.match(formatStatusReport(snapshot({ host: detectHost('Cursor') })), /^Note: Cursor's own built-in AI/m)
  })
})
