import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cliInstallCommand, execFileCall, userDataDirFrom } from './cliInstall'

const VSIX = '/home/me/.config/Code/User/globalStorage/oregannetworks.oregan-policy-manager/updates/x.vsix'

/** An `exists` for {@link cliInstallCommand} that finds only the given files */
const only =
  (...files: string[]) =>
  (path: string) =>
    files.includes(path)

describe('cliInstallCommand', () => {
  it('runs bin/code beside the executable on Linux, against the folders this window uses', () => {
    assert.deepEqual(
      cliInstallCommand({
        appRoot: '/usr/share/code/resources/app',
        cli: 'code',
        execPath: '/usr/share/code/code',
        exists: only('/usr/share/code/bin/code'),
        extensionPath: '/home/me/.vscode/extensions/oregannetworks.oregan-policy-manager-0.1.0',
        globalStoragePath: '/home/me/.config/Code/User/globalStorage/oregannetworks.oregan-policy-manager',
        platform: 'linux',
        vsixPath: VSIX,
      }),
      {
        args: [
          '--extensions-dir=/home/me/.vscode/extensions',
          '--user-data-dir=/home/me/.config/Code',
          '--install-extension',
          VSIX,
          '--force',
        ],
        command: '/usr/share/code/bin/code',
        shell: false,
      },
    )
  })

  it('runs bin/code inside the app folder on macOS', () => {
    const command = cliInstallCommand({
      appRoot: '/Applications/Visual Studio Code.app/Contents/Resources/app',
      cli: 'code',
      execPath: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/x',
      exists: only('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
      extensionPath: '/Users/me/.vscode/extensions/oregannetworks.oregan-policy-manager-0.1.0',
      globalStoragePath: '/Users/me/Library/Application Support/Code/User/globalStorage/x',
      platform: 'darwin',
      vsixPath: VSIX,
    })
    assert.equal(command?.command, '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
    assert.equal(command?.args[1], '--user-data-dir=/Users/me/Library/Application Support/Code')
  })

  it('runs bin\\code.cmd through a shell on Windows', () => {
    const command = cliInstallCommand({
      appRoot: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app',
      cli: 'code',
      execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      exists: only('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'),
      extensionPath: 'C:\\Users\\me\\.vscode\\extensions\\oregannetworks.oregan-policy-manager-0.1.0',
      globalStoragePath: 'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\x',
      platform: 'win32',
      vsixPath: 'C:\\Temp\\x.vsix',
    })
    assert.deepEqual(command, {
      args: [
        '--extensions-dir=C:\\Users\\me\\.vscode\\extensions',
        '--user-data-dir=C:\\Users\\me\\AppData\\Roaming\\Code',
        '--install-extension',
        'C:\\Temp\\x.vsix',
        '--force',
      ],
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      shell: true,
    })
  })

  it('uses the CLI name of the host editor', () => {
    const command = cliInstallCommand({
      appRoot: '/usr/share/codium/resources/app',
      cli: 'codium',
      execPath: '/usr/share/codium/codium',
      exists: only('/usr/share/codium/bin/codium'),
      extensionPath: '/home/me/.vscode-oss/extensions/oregannetworks.oregan-policy-manager-0.1.0',
      globalStoragePath: '/home/me/.config/VSCodium/User/globalStorage/x',
      platform: 'linux',
      vsixPath: VSIX,
    })
    assert.equal(command?.command, '/usr/share/codium/bin/codium')
  })

  it('gives up when the user data folder cannot be found', () => {
    const command = cliInstallCommand({
      appRoot: '/usr/share/code/resources/app',
      cli: 'code',
      execPath: '/usr/share/code/code',
      exists: only('/usr/share/code/bin/code'),
      extensionPath: '/x/oregannetworks.oregan-policy-manager-0.1.0',
      globalStoragePath: '/somewhere/else/x',
      platform: 'linux',
      vsixPath: VSIX,
    })
    assert.equal(command, undefined)
  })

  it('runs bin/code on macOS when there is no launcher named after the CLI, as for VS Code Insiders', () => {
    const appRoot = '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app'
    const command = cliInstallCommand({
      appRoot,
      cli: 'code-insiders',
      execPath: '/Applications/Visual Studio Code - Insiders.app/Contents/Frameworks/x',
      exists: only(`${appRoot}/bin/code`),
      extensionPath: '/Users/me/.vscode-insiders/extensions/oregannetworks.oregan-policy-manager-0.1.0',
      globalStoragePath: '/Users/me/Library/Application Support/Code - Insiders/User/globalStorage/x',
      platform: 'darwin',
      vsixPath: VSIX,
    })
    assert.equal(command?.command, `${appRoot}/bin/code`)
  })

  it('runs bin\\code.cmd beside the executable on Windows when resources sit in a versioned folder', () => {
    const install = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code'
    const command = cliInstallCommand({
      appRoot: `${install}\\1a2b3c4d5e\\resources\\app`,
      cli: 'code',
      execPath: `${install}\\Code.exe`,
      exists: only(`${install}\\bin\\code.cmd`),
      extensionPath: 'C:\\Users\\me\\.vscode\\extensions\\oregannetworks.oregan-policy-manager-0.1.0',
      globalStoragePath: 'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\x',
      platform: 'win32',
      vsixPath: 'C:\\Temp\\x.vsix',
    })
    assert.equal(command?.command, `${install}\\bin\\code.cmd`)
  })

  it('falls back to bin beside resources, for an editor whose executable sits elsewhere', () => {
    const command = cliInstallCommand({
      appRoot: '/opt/editor/resources/app',
      cli: 'code',
      execPath: '/opt/editor/libexec/editor',
      exists: only('/opt/editor/bin/code'),
      extensionPath: '/home/me/.vscode/extensions/oregannetworks.oregan-policy-manager-0.1.0',
      globalStoragePath: '/home/me/.config/Code/User/globalStorage/x',
      platform: 'linux',
      vsixPath: VSIX,
    })
    assert.equal(command?.command, '/opt/editor/bin/code')
  })

  it('is undefined when there is no CLI where the editor keeps it', () => {
    const command = cliInstallCommand({
      appRoot: '/usr/share/code/resources/app',
      cli: 'code',
      execPath: '/usr/share/code/code',
      exists: only(),
      extensionPath: '/home/me/.vscode/extensions/oregannetworks.oregan-policy-manager-0.1.0',
      globalStoragePath: '/home/me/.config/Code/User/globalStorage/x',
      platform: 'linux',
      vsixPath: VSIX,
    })
    assert.equal(command, undefined)
  })
})

describe('execFileCall', () => {
  it('quotes the command and every argument for a shell, so a folder with spaces stays one argument', () => {
    assert.deepEqual(
      execFileCall({ args: ['--install-extension', 'C:\\a b\\x.vsix'], command: 'C:\\a b\\code.cmd', shell: true }),
      {
        args: ['"--install-extension"', '"C:\\a b\\x.vsix"'],
        command: '"C:\\a b\\code.cmd"',
        shell: true,
      },
    )
  })

  it('leaves them as they are without a shell', () => {
    const call = { args: ['--install-extension', '/a b/x.vsix'], command: '/usr/share/code/bin/code', shell: false }
    assert.deepEqual(execFileCall(call), call)
  })
})

describe('userDataDirFrom', () => {
  it('finds the user data folder above the global storage of the default profile or a named one', () => {
    assert.equal(userDataDirFrom('/home/me/.config/Code/User/globalStorage/x', 'linux'), '/home/me/.config/Code')
    assert.equal(
      userDataDirFrom('/home/me/.config/Code/User/profiles/-6a8bc6e1/globalStorage/x', 'linux'),
      '/home/me/.config/Code',
    )
  })

  it('works for a portable install, whose user data folder has another name', () => {
    assert.equal(
      userDataDirFrom('/opt/vscode/data/user-data/User/globalStorage/x', 'linux'),
      '/opt/vscode/data/user-data',
    )
  })
})
