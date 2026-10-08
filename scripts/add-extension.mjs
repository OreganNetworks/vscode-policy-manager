// Installs the packaged VSIX with the `code` CLI, for the "Add extension" and "Try extension" tasks:
//
//   node scripts/add-extension.mjs          into the Default profile of your own editor, where the policy applies
//                                           for real
//   node scripts/add-extension.mjs --clean  into a throwaway editor under .vscode-test/try/, which it then opens
//
// --force lets the local build replace whatever is installed, including a newer release from the self-update.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { name, publisher, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const vsix = join(root, `${name}-${version}.vsix`)
if (!existsSync(vsix)) {
  console.error(`${vsix} not found - run pnpm package first`)
  process.exit(1)
}

const clean = process.argv[2] === '--clean'
const tryDir = join(root, '.vscode-test', 'try')
/*
 * Your own editor gets it in the Default profile only.  Installed with --profile, a named profile keeps a copy of its
 * own, which the self-update never replaces, so stable rolled back to an older version would not reach that profile.
 */
const editorArgs = clean
  ? [`--user-data-dir=${join(tryDir, 'user-data')}`, `--extensions-dir=${join(tryDir, 'extensions')}`]
  : []

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

if (clean) {
  openWindow(editorArgs)
} else if (await isAppliedToAllProfiles()) {
  console.log('Applied to all profiles already. Run Developer: Reload Window in each open window.')
} else {
  // It applies itself to all profiles the first time it runs, which needs a window with a profile it is in
  openWindow(['--profile', 'Default'])
  console.log(
    'Opened a window with the Default profile, where the extension applies itself to all profiles. Close it once the ' +
      'Oregan Policy Manager output says so, then run Developer: Reload Window in each of your other windows.',
  )
}

/**
 * Opens a new editor window, without waiting for it.
 *
 * @param {string[]} windowArgs  The editor arguments, before `--new-window`.
 */
function openWindow(windowArgs) {
  spawn('code', args([...windowArgs, '--new-window']), { detached: true, shell, stdio: 'ignore' }).unref()
}

/**
 * Reads whether the copy in the Default profile is applied to all profiles, from the extensions.json of the editor,
 * which `VSCODE_EXTENSIONS` moves when it is set.
 *
 * @returns {Promise<boolean>} False when it isn't, or the file can't be read.
 */
async function isAppliedToAllProfiles() {
  const dir = process.env.VSCODE_EXTENSIONS || join(homedir(), '.vscode', 'extensions')
  try {
    const entries = JSON.parse(await readFile(join(dir, 'extensions.json'), 'utf8'))
    const id = `${publisher}.${name}`.toLowerCase()
    return entries.some(entry => entry.identifier?.id?.toLowerCase() === id && entry.metadata?.isApplicationScoped)
  } catch {
    return false
  }
}
