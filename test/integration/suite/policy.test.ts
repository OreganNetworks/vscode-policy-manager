import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'

const EXTENSION_ID = 'oregan.oregan-policy-manager'
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

  it('shows the status report', async () => {
    await vscode.commands.executeCommand('oregan.showPolicyStatus')
  })
})
