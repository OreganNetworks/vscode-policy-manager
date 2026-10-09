import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron'
import { EXTENSION_ID, PROFILE, readDefaultEntry } from './profiles/manifest'

const ROOT = resolve(__dirname, '../../..') // out/test/integration -> repository root
const CACHE = join(ROOT, '.vscode-test')
/*
 * The editor keeps its IPC socket in the user data folder, and macOS limits a socket path to 103 characters, which the
 * checkout folder of a CI runner plus `.vscode-test/profiles-user-data/1.141-main.sock` passes.  So on macOS the user
 * data folders go under the temporary folder.
 */
const USER_DATA_ROOT = process.platform === 'darwin' ? join(tmpdir(), 'opm-test') : CACHE
const FIXTURES = ['vscjava.vscode-java-upgrade', 'ms-dotnettools.vscode-dotnet-modernize']
const VSCE = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce')

/** Options for {@link run} */
type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv }

function run(command: string, args: string[], { cwd = ROOT, env = process.env }: RunOptions = {}): void {
  // The editor CLI and vsce are .cmd files on Windows, which only run through a shell, with every argument quoted
  const result =
    process.platform === 'win32'
      ? spawnSync([command, ...args].map(arg => `"${arg}"`).join(' '), { cwd, env, shell: true, stdio: 'inherit' })
      : spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

/** Arguments to {@link runProfilesSuite} */
type EditorOptions = {
  /** The CLI arguments from `resolveCliArgsFromVSCodeExecutablePath`, less the profile ones */
  baseArgs: string[]
  cli: string
  vscodeExecutablePath: string
}

/**
 * Downloads the editor (the `engines.vscode` floor by default; set `VSCODE_TEST_VERSION=stable` for the latest),
 * installs the fake Copilot fixtures into a fresh profile, then runs the suite in the extension host.  The profiles
 * suite follows.
 */
async function main(): Promise<void> {
  // A shell started by an extension (a Claude Code session) inherits it, and the editor then starts as plain Node
  delete process.env.ELECTRON_RUN_AS_NODE
  const version = process.env.VSCODE_TEST_VERSION ?? '1.90.0'
  const extensionsDir = join(CACHE, 'extensions')
  const userDataDir = join(USER_DATA_ROOT, 'user-data')
  rmSync(extensionsDir, { force: true, recursive: true })
  rmSync(userDataDir, { force: true, recursive: true })
  mkdirSync(join(CACHE, 'fixtures'), { recursive: true })

  const vscodeExecutablePath = await downloadAndUnzipVSCode(version)
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath)
  const profileArgs = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`]
  // Our own profile arguments replace whatever defaults the helper chose
  const baseArgs = cliArgs.filter(arg => !arg.startsWith('--extensions-dir') && !arg.startsWith('--user-data-dir'))
  for (const fixture of FIXTURES) {
    const vsix = join(CACHE, 'fixtures', `${fixture}.vsix`)
    run(VSCE, ['package', '--skip-license', '--allow-missing-repository', '--out', vsix], {
      cwd: join(ROOT, 'test/fixtures', fixture),
    })
    run(cli, [...baseArgs, ...profileArgs, '--install-extension', vsix])
  }

  await runTests({
    extensionDevelopmentPath: ROOT,
    extensionTestsEnv: { OPM_TEST_EXTENSIONS_DIR: extensionsDir, OPM_TEST_USER_DATA_DIR: userDataDir },
    extensionTestsPath: join(__dirname, 'suite'),
    launchArgs: [...profileArgs, '--disable-workspace-trust'],
    vscodeExecutablePath,
  })
  const packaged = await runProfilesSuite({ baseArgs, cli, vscodeExecutablePath })
  await runInstallerSuite({ baseArgs, cli, vscodeExecutablePath, ...packaged })
}

/**
 * The release install, which the suite above can't cover: it runs the source in development mode, where the extension
 * never applies itself to all profiles.  Installs the packaged VSIX into a named profile only, then checks that it
 * applies itself to all profiles there, and so runs in a window with the Default profile too.  Then installs the next
 * version from a window with the named profile, the way the self-update does, and checks both windows run it.
 */
async function runProfilesSuite({ baseArgs, cli, vscodeExecutablePath }: EditorOptions): Promise<PackagedVsixes> {
  const extensionsDir = join(CACHE, 'profiles-extensions')
  const userDataDir = join(USER_DATA_ROOT, 'profiles-user-data')
  rmSync(extensionsDir, { force: true, recursive: true })
  rmSync(userDataDir, { force: true, recursive: true })
  const vsix = join(CACHE, 'oregan-policy-manager.vsix')
  run(VSCE, ['package', '--no-dependencies', '--out', vsix])
  const { nextVersion, nextVsix } = packageNextVersion()

  const profileArgs = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`]
  const step = (name: string, extraArgs: string[] = []) =>
    runTests({
      extensionDevelopmentPath: join(ROOT, 'test/fixtures/profiles-host'),
      extensionTestsEnv: {
        OPM_TEST_EXTENSIONS_DIR: extensionsDir,
        OPM_TEST_NEXT_VERSION: nextVersion,
        OPM_TEST_NEXT_VSIX: nextVsix,
        OPM_TEST_REPO: ROOT,
        OPM_TEST_USER_DATA_DIR: userDataDir,
      },
      extensionTestsPath: join(__dirname, 'profiles', `${name}.js`),
      launchArgs: [...profileArgs, '--disable-workspace-trust', ...extraArgs],
      vscodeExecutablePath,
    })

  await step('createProfile', ['--profile', PROFILE])
  run(cli, [...baseArgs, ...profileArgs, '--profile', PROFILE, '--install-extension', vsix])
  if (readDefaultEntry(extensionsDir)) throw new Error('the install into a named profile also went into Default')
  await step('appliesItself', ['--profile', PROFILE])
  await step('runsInDefault')
  await step('updatesFromProfile', ['--profile', PROFILE])
  await step('runsNextVersion')
  await step('runsNextVersion', ['--profile', PROFILE])
  return { nextVersion, nextVsix, vsix }
}

/** The VSIXes the profiles suite packages, which the installer suite uses too */
type PackagedVsixes = {
  nextVersion: string
  /** One patch version on: the VSIX the install script installs */
  nextVsix: string
  /** This version: the VSIX a named profile gets a copy of its own of, for the script to remove */
  vsix: string
}

/** Arguments to {@link runInstallerSuite} */
type InstallerOptions = EditorOptions & PackagedVsixes

/**
 * The install script, as a developer runs it: `install.sh`, or `install.ps1` on Windows.  The editor starts with a copy
 * under the old ID in the Default profile, and a copy of its own in a named profile.  The script must remove both,
 * install the next version into the Default profile and open the setup window, where the extension applies itself to
 * all profiles and closes the window again.
 */
async function runInstallerSuite({
  baseArgs,
  cli,
  nextVersion,
  nextVsix,
  vscodeExecutablePath,
  vsix,
}: InstallerOptions): Promise<void> {
  const extensionsDir = join(CACHE, 'installer-extensions')
  const userDataDir = join(USER_DATA_ROOT, 'installer-user-data')
  rmSync(extensionsDir, { force: true, recursive: true })
  rmSync(userDataDir, { force: true, recursive: true })
  const profileArgs = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`]
  const oldIdVsix = packageCopy('installer-old-id', { publisher: 'oregan' })

  await runTests({
    extensionDevelopmentPath: join(ROOT, 'test/fixtures/profiles-host'),
    extensionTestsPath: join(__dirname, 'profiles', 'createProfile.js'),
    launchArgs: [...profileArgs, '--disable-workspace-trust', '--profile', PROFILE],
    vscodeExecutablePath,
  })
  run(cli, [...baseArgs, ...profileArgs, '--install-extension', oldIdVsix])
  run(cli, [...baseArgs, ...profileArgs, '--profile', PROFILE, '--install-extension', vsix])

  const env = { ...process.env, OPM_EXTENSIONS_DIR: extensionsDir, OPM_USER_DATA_DIR: userDataDir }
  if (process.platform === 'win32') {
    const script = join(ROOT, 'scripts', 'install.ps1')
    run(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Vsix', nextVsix, '-Cli', cli],
      {
        env,
      },
    )
  } else {
    run('sh', [join(ROOT, 'scripts', 'install.sh'), '--vsix', nextVsix, '--cli', cli], { env })
  }

  const entry = readDefaultEntry(extensionsDir)
  if (entry?.version !== nextVersion || !entry?.isApplicationScoped)
    throw new Error(`the Default profile lists ${JSON.stringify(entry)}, not ${nextVersion} applied to all profiles`)
  if (listsExtension(join(extensionsDir, 'extensions.json'), 'oregan.oregan-policy-manager'))
    throw new Error('the copy under the old ID is still installed')
  if (listsExtension(namedProfileList(userDataDir, PROFILE), EXTENSION_ID))
    throw new Error(`the ${PROFILE} profile still has a copy of its own`)
  await waitForSetupWindowToClose(userDataDir)
}

/** Whether an `extensions.json` lists an extension */
function listsExtension(path: string, id: string): boolean {
  if (!existsSync(path)) return false
  const entries = JSON.parse(readFileSync(path, 'utf8')) as { identifier: { id: string } }[]
  return entries.some(entry => entry.identifier.id.toLowerCase() === id)
}

/** The `extensions.json` of a named profile, which the editor keeps under the location in its `storage.json` */
function namedProfileList(userDataDir: string, name: string): string {
  const storage = JSON.parse(readFileSync(join(userDataDir, 'User', 'globalStorage', 'storage.json'), 'utf8')) as {
    userDataProfiles?: { location: string; name: string }[]
  }
  const found = storage.userDataProfiles?.find(userProfile => userProfile.name === name)
  if (!found) throw new Error(`no ${name} profile`)
  return join(userDataDir, 'User', 'profiles', found.location, 'extensions.json')
}

/**
 * Waits for the extension in the setup window to log that it closes the window, then for the editor to quit: on Linux
 * and Windows it does once its last window has closed.  macOS keeps an editor running with no windows, so there the
 * editor is stopped instead.
 */
async function waitForSetupWindowToClose(userDataDir: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (!readLogs(join(userDataDir, 'logs')).includes('Setup window: applied to all profiles')) {
    if (Date.now() > deadline) throw new Error('the extension in the setup window never closed it')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (process.platform === 'win32') return
  if (process.platform === 'darwin') {
    spawnSync('pkill', ['-f', userDataDir])
    return
  }
  while (spawnSync('pgrep', ['-f', userDataDir]).status === 0) {
    if (Date.now() > deadline) throw new Error('the editor kept running after the setup window closed')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Every Oregan Policy Manager output log under a logs folder, joined */
function readLogs(logs: string): string {
  if (!existsSync(logs)) return ''
  return readdirSync(logs, { encoding: 'utf8', recursive: true })
    .filter(path => path.endsWith(join(EXTENSION_ID, 'Oregan Policy Manager.log')))
    .map(path => readFileSync(join(logs, path), 'utf8'))
    .join('\n')
}

/** A VSIX one patch version on from `package.json`, built from a copy, for the update steps of the profiles suite */
function packageNextVersion(): { nextVersion: string; nextVsix: string } {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  const [major, minor, patch] = manifest.version.split('.').map(Number)
  const nextVersion = `${major}.${minor}.${patch + 1}`
  return { nextVersion, nextVsix: packageCopy('profiles-next', { version: nextVersion }) }
}

/**
 * Packages a copy of the extension with some `package.json` fields changed, such as another version or publisher.
 *
 * @param name     The folder for the copy under `.vscode-test/`, and the name of the VSIX.
 * @param changes  The fields to change.
 * @returns The VSIX.
 */
function packageCopy(name: string, changes: Record<string, string>): string {
  const copy = join(CACHE, name)
  rmSync(copy, { force: true, recursive: true })
  for (const file of ['.vscodeignore', 'LICENSE', 'README.md', 'images', 'out'])
    cpSync(join(ROOT, file), join(copy, file), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
  const changed = { ...manifest, ...changes }
  writeFileSync(join(copy, 'package.json'), JSON.stringify(changed, null, 2))
  const vsix = join(CACHE, `${name}.vsix`)
  run(VSCE, ['package', '--no-dependencies', '--out', vsix], { cwd: copy })
  return vsix
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- the runner reports straight to the terminal
  console.error(error)
  process.exit(1)
})
