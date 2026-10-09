// Installs the packaged VSIX, for the "Add extension" and "Try extension" tasks:
//
//   node scripts/add-extension.mjs          into your own editor, where the policy applies for real, with the install
//                                           script developers use (install.sh, or install.ps1 on Windows)
//   node scripts/add-extension.mjs --clean  into a throwaway editor under .vscode-test/try/, which it then opens
//
// --force lets the local build replace whatever is installed, including a newer release from the self-update.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const vsix = join(root, `${name}-${version}.vsix`)
if (!existsSync(vsix)) {
  console.error(`${vsix} not found - run pnpm package first`)
  process.exit(1)
}

const windows = process.platform === 'win32'

if (process.argv[2] === '--clean') {
  const tryDir = join(root, '.vscode-test', 'try')
  const editorArgs = [`--user-data-dir=${join(tryDir, 'user-data')}`, `--extensions-dir=${join(tryDir, 'extensions')}`]
  // `code` is a .cmd file on Windows, which only runs through a shell, and the shell needs the arguments quoted
  const args = list => (windows ? list.map(arg => `"${arg}"`) : list)
  // The CLI of VS Code 1.140 and later prints a url.parse() deprecation warning from its own code on every install
  const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' ') }
  const install = spawnSync('code', args([...editorArgs, '--install-extension', vsix, '--force']), {
    env,
    shell: windows,
    stdio: 'inherit',
  })
  if (install.status !== 0) process.exit(install.status ?? 1)
  spawn('code', args([...editorArgs, '--new-window']), { detached: true, shell: windows, stdio: 'ignore' }).unref()
} else {
  /*
   * The install script puts it in the Default profile only, never with --profile: a named profile with a copy of its
   * own keeps it when stable is rolled back.  When the copy isn't applied to all profiles yet, the script opens a
   * window on a setup file, which the extension closes again once it has applied itself.
   */
  const install = windows
    ? spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(root, 'scripts', 'install.ps1'),
          '-Vsix',
          vsix,
          '-Cli',
          'code.cmd',
        ],
        { stdio: 'inherit' },
      )
    : spawnSync('sh', [join(root, 'scripts', 'install.sh'), '--vsix', vsix, '--cli', 'code'], { stdio: 'inherit' })
  process.exit(install.status ?? 1)
}
