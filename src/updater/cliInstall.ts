/*
 * Installing the self-update with the editor CLI.  From a window with a named profile, the
 * `workbench.extensions.installExtension` command writes the new version into the extension list for that profile
 * only, while an extension applied to all profiles runs from the list for the default profile, so every window kept
 * running the old version (VS Code 1.90.0 and 1.139.0).  The CLI with no `--profile` writes the list for the default
 * profile, from whichever window has the update cycle.
 */
import { execFile } from 'node:child_process'
import { posix, win32 } from 'node:path'

const CLI_TIMEOUT_MS = 2 * 60 * 1000 // an install takes seconds; this only stops a hung CLI holding the cycle

/** Arguments to {@link cliInstallCommand} */
export type CliInstallOptions = {
  /** `vscode.env.appRoot`: the `resources/app` folder of the editor install */
  appRoot: string
  /** The CLI for the host editor, from `detectHost()`: `code`, `codium`, `cursor` or `windsurf` */
  cli: string
  /** `ExtensionContext.extensionPath`, which sits in the extensions folder beside the other extensions */
  extensionPath: string
  /** `ExtensionContext.globalStorageUri.fsPath`, which sits under the user data folder */
  globalStoragePath: string
  platform: NodeJS.Platform
  vsixPath: string
}

/** A CLI call; {@link execFileCall} turns it into the arguments for `execFile` */
export type CliCommand = {
  args: string[]
  /** The path of the CLI */
  command: string
  /** A `.cmd` file on Windows only runs through a shell */
  shell: boolean
}

/**
 * The CLI call that installs `vsixPath` into the default profile, against the extensions and user data folders this
 * window uses - set explicitly, so a portable install or one started with `--user-data-dir` gets the same folders.
 * `--force` lets it install an older version, for a rollback.
 *
 * @param options  Where the editor, this extension and its global storage are.
 * @returns The call, or `undefined` when the user data folder can't be worked out from the global storage path.
 *
 * @example
 * cliInstallCommand({
 *   appRoot: '/usr/share/code/resources/app',
 *   cli: 'code',
 *   extensionPath: '/home/me/.vscode/extensions/oregannetworks.oregan-policy-manager-0.1.0',
 *   globalStoragePath: '/home/me/.config/Code/User/globalStorage/oregannetworks.oregan-policy-manager',
 *   platform: 'linux',
 *   vsixPath: '/tmp/x.vsix',
 * })
 * // { command: '/usr/share/code/bin/code', shell: false, args: ['--extensions-dir=/home/me/.vscode/extensions',
 * //   '--user-data-dir=/home/me/.config/Code', '--install-extension', '/tmp/x.vsix', '--force'] }
 */
export function cliInstallCommand({
  appRoot,
  cli,
  extensionPath,
  globalStoragePath,
  platform,
  vsixPath,
}: CliInstallOptions): CliCommand | undefined {
  const userDataDir = userDataDirFrom(globalStoragePath, platform)
  if (userDataDir === undefined) return undefined
  const path = platform === 'win32' ? win32 : posix
  // macOS keeps bin/ inside the app folder; Linux and Windows keep it beside resources/
  const binDir = platform === 'darwin' ? path.join(appRoot, 'bin') : path.join(appRoot, '..', '..', 'bin')
  const command = path.join(binDir, platform === 'win32' ? `${cli}.cmd` : cli)
  const args = [
    `--extensions-dir=${path.dirname(extensionPath)}`,
    `--user-data-dir=${userDataDir}`,
    '--install-extension',
    vsixPath,
    '--force',
  ]
  return { args, command, shell: platform === 'win32' }
}

/**
 * The `execFile` arguments for a CLI call.  Through a shell, Node joins the command and its arguments with spaces, so
 * each one is quoted: the install folder on Windows is `Microsoft VS Code`.
 *
 * @param command  From {@link cliInstallCommand}.
 * @returns The file, arguments and shell option to pass to `execFile`.
 */
export function execFileCall({ args, command, shell }: CliCommand): CliCommand {
  const quote = (value: string) => (shell ? `"${value}"` : value)
  return { args: args.map(quote), command: quote(command), shell }
}

/**
 * The user data folder, from a global storage path under it: `<user data>/User/globalStorage/<id>`, or
 * `<user data>/User/profiles/<profile>/globalStorage/<id>` for a named profile.
 *
 * @param globalStoragePath  `ExtensionContext.globalStorageUri.fsPath`.
 * @param platform           Picks the path separator.
 * @returns The folder above the last `User` folder in the path, or `undefined` when there is none.
 */
export function userDataDirFrom(globalStoragePath: string, platform: NodeJS.Platform): string | undefined {
  const { sep } = platform === 'win32' ? win32 : posix
  const parts = globalStoragePath.split(sep)
  const user = parts.lastIndexOf('User')
  return user > 0 ? parts.slice(0, user).join(sep) : undefined
}

/**
 * Runs a CLI install and resolves with its output.  `NODE_OPTIONS=--no-deprecation` keeps out the
 * `url.parse()` deprecation warning that the CLI of VS Code 1.140 and later prints during every install.
 *
 * @param command  From {@link cliInstallCommand}.
 * @returns What the CLI wrote to stdout, trimmed.
 * @throws When the CLI exits with an error, with its stderr in the message.
 */
export function runCliInstall(call: CliCommand): Promise<string> {
  const { args, command, shell } = execFileCall(call)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' '),
  }
  // Not set in the extension host today; removed so the install never goes through the CLI server of a window
  delete env.VSCODE_IPC_HOOK_CLI
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, shell, timeout: CLI_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${String(stderr).trim() || error.message}`))
      else resolve(String(stdout).trim())
    })
  })
}
