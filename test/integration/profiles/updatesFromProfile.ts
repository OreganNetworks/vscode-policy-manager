import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { EXTENSION_ID, waitFor } from './manifest'

/** A CLI call, as `out/updater/cliInstall.js` builds it */
type CliCommand = { args: string[]; command: string; shell: boolean }

/** The part of `out/updater/cliInstall.js` this step uses - loaded from the build, since the suite has its own rootDir */
type CliInstall = {
  cliInstallCommand(options: {
    appRoot: string
    cli: string
    execPath: string
    exists: (path: string) => boolean
    extensionPath: string
    globalStoragePath: string
    platform: NodeJS.Platform
    vsixPath: string
  }): CliCommand | undefined
  runCliInstall(command: CliCommand): Promise<string>
}

/**
 * From a window with the named profile, installs the next version the way the self-update does: with the editor CLI,
 * into the default profile.  The install command would put it in the list for this profile only.
 */
export async function run(): Promise<void> {
  await waitFor(() => vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true, 'activation in the profile')
  const { cliInstallCommand, runCliInstall } = (await import(
    join(env('OPM_TEST_REPO'), 'out/updater/cliInstall.js')
  )) as CliInstall
  const ours = vscode.extensions.getExtension(EXTENSION_ID)!
  const command = cliInstallCommand({
    appRoot: vscode.env.appRoot,
    cli: 'code',
    execPath: process.execPath,
    exists: existsSync,
    extensionPath: ours.extensionPath,
    // An extension applied to all profiles keeps its global storage in the default profile, in every window
    globalStoragePath: join(env('OPM_TEST_USER_DATA_DIR'), 'User', 'globalStorage', EXTENSION_ID),
    platform: process.platform,
    vsixPath: env('OPM_TEST_NEXT_VSIX'),
  })
  if (!command) throw new Error('no CLI command for this editor')
  await runCliInstall(command)
}

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}
