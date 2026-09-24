import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron'

const ROOT = resolve(__dirname, '../../..') // out/test/integration -> repository root
const CACHE = join(ROOT, '.vscode-test')
const FIXTURES = ['vscjava.vscode-java-upgrade', 'ms-dotnettools.vscode-dotnet-modernize']
const VSCE = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce')

function run(command: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

/**
 * Downloads the editor (the `engines.vscode` floor by default; set `VSCODE_TEST_VERSION=stable` for the latest),
 * installs the fake Copilot fixtures into a fresh profile, then runs the suite in the extension host.
 */
async function main(): Promise<void> {
  const version = process.env.VSCODE_TEST_VERSION ?? '1.90.0'
  const extensionsDir = join(CACHE, 'extensions')
  const userDataDir = join(CACHE, 'user-data')
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
    extensionTestsEnv: { OPM_TEST_EXTENSIONS_DIR: extensionsDir },
    extensionTestsPath: join(__dirname, 'suite'),
    launchArgs: [...profileArgs, '--disable-workspace-trust'],
    vscodeExecutablePath,
  })
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- the runner reports straight to the terminal
  console.error(error)
  process.exit(1)
})
