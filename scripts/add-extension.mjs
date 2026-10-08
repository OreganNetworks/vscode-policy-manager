// Installs the packaged VSIX with the `code` CLI, for the "Add extension" and "Try extension" tasks:
//
//   node scripts/add-extension.mjs <profile>  into a profile of your own editor, where the policy applies for real
//   node scripts/add-extension.mjs --clean    into a throwaway editor under .vscode-test/try/, which it then opens
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

const [target = 'Default'] = process.argv.slice(2)
const clean = target === '--clean'
const tryDir = join(root, '.vscode-test', 'try')
const editorArgs = clean
  ? [`--user-data-dir=${join(tryDir, 'user-data')}`, `--extensions-dir=${join(tryDir, 'extensions')}`]
  : ['--profile', target]

// `code` is a .cmd file on Windows, which only runs through a shell, and the shell needs the arguments quoted
const shell = process.platform === 'win32'
const args = list => (shell ? list.map(arg => `"${arg}"`) : list)

// The CLI of VS Code 1.140 and later prints a url.parse() deprecation warning from its own code on every install
const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' ') }
const install = spawnSync('code', args([...editorArgs, '--install-extension', vsix, '--force']), {
  env,
  shell,
  stdio: 'inherit',
})
if (install.status !== 0) process.exit(install.status ?? 1)
if (clean) spawn('code', args([...editorArgs, '--new-window']), { detached: true, shell, stdio: 'ignore' }).unref()
