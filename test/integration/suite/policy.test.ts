import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'

const EXTENSION_ID = 'oregannetworks.oregan-policy-manager'
const LOG_FILE = join(EXTENSION_ID, 'Oregan Policy Manager.log')
/** Managed fixtures (from `MANAGED_EXTENSIONS`), dependant first so removal order is exercised */
const FIXTURE_IDS = ['ms-dotnettools.vscode-dotnet-modernize', 'vscjava.vscode-java-upgrade']

async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

const inspect = (key: string) => vscode.workspace.getConfiguration().inspect(key)

function extensionsDir(): string {
  const dir = process.env.OPM_TEST_EXTENSIONS_DIR
  if (!dir) throw new Error('OPM_TEST_EXTENSIONS_DIR is not set')
  return dir
}

/** The output channel as the editor logs it, under `<user-data-dir>/logs/<session>/window1/exthost/<id>/` */
function readOutputLog(): string {
  const dir = process.env.OPM_TEST_USER_DATA_DIR
  if (!dir) throw new Error('OPM_TEST_USER_DATA_DIR is not set')
  const logs = join(dir, 'logs')
  const file = readdirSync(logs, { encoding: 'utf8', recursive: true }).find(path => path.endsWith(LOG_FILE))
  return file ? readFileSync(join(logs, file), 'utf8') : ''
}

/** IDs the on-disk manifest currently lists as installed, lower-cased - `undefined` while the file is mid-write */
function readInstalledIds(): Set<string> | undefined {
  try {
    const records = JSON.parse(readFileSync(join(extensionsDir(), 'extensions.json'), 'utf8')) as {
      identifier: { id: string }
    }[]
    return new Set(records.map(record => record.identifier.id.toLowerCase()))
  } catch {
    return undefined
  }
}

/** `.obsolete` keys are `"<id>-<version>"` - present while the editor has queued an extension for deletion */
function readObsoleteKeys(): string[] {
  try {
    const entries = JSON.parse(readFileSync(join(extensionsDir(), '.obsolete'), 'utf8')) as Record<string, boolean>
    return Object.keys(entries).map(key => key.toLowerCase())
  } catch {
    return []
  }
}

/**
 * True once `id` is both off the on-disk manifest and marked obsolete - proof the editor actually installed it and
 * then uninstalled it, rather than never loading it under this ID in the first place
 */
function isRemovedOnDisk(id: string): boolean {
  const installed = readInstalledIds()
  if (!installed) return false
  const lower = id.toLowerCase()
  if (installed.has(lower)) return false
  return readObsoleteKeys().some(key => key.startsWith(`${lower}-`))
}

describe('Oregan Policy Manager', () => {
  before(async () => {
    await waitFor(() => vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true, 'activation')
  })

  it('turns telemetry off at user level', async () => {
    await waitFor(() => inspect('telemetry.telemetryLevel')?.globalValue === 'off', 'telemetry.telemetryLevel')
  })

  it('turns the built-in AI off, where this editor has the setting', async function () {
    if (inspect('chat.disableAIFeatures')?.defaultValue === undefined) return this.skip()
    await waitFor(() => inspect('chat.disableAIFeatures')?.globalValue === true, 'chat.disableAIFeatures')
  })

  it('leaves the managed settings and extensions out of Settings Sync', async function () {
    /*
     * Settings Sync registers its settings from a workbench contribution, which can start after this extension has
     * activated: on macOS with VS Code 1.141 it had not when the test ran.  The extension writes the lists again when
     * they change, registration included, so wait for it before deciding the editor has no Settings Sync.
     */
    const registered = () => inspect('settingsSync.ignoredSettings')?.defaultValue !== undefined
    await waitFor(registered, 'Settings Sync to register its settings', 10_000).catch(() => undefined)
    if (!registered()) return this.skip()
    const listed = (key: string) => (inspect(key)?.globalValue as string[] | undefined) ?? []
    await waitFor(
      () =>
        ['chat.disableAIFeatures', 'telemetry.telemetryLevel'].every(key =>
          listed('settingsSync.ignoredSettings').includes(key),
        ) && ['github.copilot', EXTENSION_ID].every(id => listed('settingsSync.ignoredExtensions').includes(id)),
      'the Settings Sync lists',
    )
  })

  it('removes the managed fixtures, dependant first', async () => {
    await waitFor(() => FIXTURE_IDS.every(id => !vscode.extensions.getExtension(id)), 'the fixtures to be uninstalled')
    // The editor writes extensions.json and .obsolete asynchronously, after the live view already updates
    await waitFor(
      () => FIXTURE_IDS.every(id => isRemovedOnDisk(id)),
      'the fixtures to be off extensions.json and marked obsolete',
    )
  })

  it('puts a drifted setting back', async () => {
    await vscode.workspace
      .getConfiguration()
      .update('telemetry.telemetryLevel', 'all', vscode.ConfigurationTarget.Global)
    await waitFor(() => inspect('telemetry.telemetryLevel')?.globalValue === 'off', 'the drift restore')
  })

  it('reports a compliant machine in the output channel', async () => {
    await vscode.commands.executeCommand('oregan.showPolicyStatus')
    let log = ''
    // The editor writes the channel to disk shortly after the command returns
    await waitFor(() => (log = readOutputLog()).includes('Overall:'), 'the status report in the output log')
    assert.match(log, /^Overall: compliant$/m)
  })
})
