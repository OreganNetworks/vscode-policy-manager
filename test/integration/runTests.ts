import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron'
import { PROFILE, readDefaultEntry } from './profiles/manifest'

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

function run(command: string, args: string[], cwd = ROOT): void {
  // The editor CLI and vsce are .cmd files on Windows, which only run through a shell, with every argument quoted
  const result =
    process.platform === 'win32'
      ? spawnSync([command, ...args].map(arg => `"${arg}"`).join(' '), { cwd, shell: true, stdio: 'inherit' })
      : spawnSync(command, args, { cwd, stdio: 'inherit' })
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
    run(
      VSCE,
      ['package', '--skip-license', '--allow-missing-repository', '--out', vsix],
      join(ROOT, 'test/fixtures', fixture),
    )
    run(cli, [...baseArgs, ...profileArgs, '--install-extension', vsix])
  }

  await runTests({
    extensionDevelopmentPath: ROOT,
    extensionTestsEnv: { OPM_TEST_EXTENSIONS_DIR: extensionsDir, OPM_TEST_USER_DATA_DIR: userDataDir },
    extensionTestsPath: join(__dirname, 'suite'),
    launchArgs: [...profileArgs, '--disable-workspace-trust'],
    vscodeExecutablePath,
  })
  await runProfilesSuite({ baseArgs, cli, vscodeExecutablePath })
}

/**
 * The release install, which the suite above can't cover: it runs the source in development mode, where the extension
 * never applies itself to all profiles.  Installs the packaged VSIX into a named profile only, then checks that it
 * applies itself to all profiles there, and so runs in a window with the Default profile too.  Then installs the next
 * version from a window with the named profile, the way the self-update does, and checks both windows run it.
 */
async function runProfilesSuite({ baseArgs, cli, vscodeExecutablePath }: EditorOptions): Promise<void> {
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
}

/** A VSIX one patch version on from `package.json`, built from a copy, for the update steps of the profiles suite */
function packageNextVersion(): { nextVersion: string; nextVsix: string } {
  const copy = join(CACHE, 'profiles-next')
  rmSync(copy, { force: true, recursive: true })
  for (const file of ['.vscodeignore', 'LICENSE', 'README.md', 'images', 'out'])
    cpSync(join(ROOT, file), join(copy, file), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  const [major, minor, patch] = manifest.version.split('.').map(Number)
  const nextVersion = `${major}.${minor}.${patch + 1}`
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ ...manifest, version: nextVersion }, null, 2))
  const nextVsix = join(CACHE, `oregan-policy-manager-${nextVersion}.vsix`)
  run(VSCE, ['package', '--no-dependencies', '--out', nextVsix], copy)
  return { nextVersion, nextVsix }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- the runner reports straight to the terminal
  console.error(error)
  process.exit(1)
})
