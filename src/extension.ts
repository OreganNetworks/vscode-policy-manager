import { dirname, isAbsolute, join, relative } from 'node:path'
import * as vscode from 'vscode'
import {
  applyToAllProfiles,
  type ApplyToAllProfilesOptions,
  readAppliedToAllProfiles,
} from './policy/applyToAllProfiles'
import { createCopilotRemover, type ExtensionRegistry, type InstalledExtension } from './policy/removeCopilotExtensions'
import { createDriftHandler } from './policy/keepSettings'
import { aiFirstHostMessage, detectHost } from './host'
import { IDE_CONFIGURATION_URL, POLICY_URL } from './links'
import { describeError } from './logger'
import {
  AI_SWITCHED_OFF,
  createNotices,
  type Notice,
  noticeForRestore,
  type NoticeStore,
  type SavedNotice,
} from './notices'
import { compareVersions } from './updater/manifest'
import { applyPolicy, findAiSettingsOutOfLine, findSwitchedOffAiSettings, type SettingsStore } from './policy/settings'
import { CLAUDE_CODE_ID, claudeCodeMessage } from './policy/recommendClaudeCode'
import { collectStatusSnapshot, formatStatusReport } from './status'
import {
  createUpdater,
  scheduleChecks,
  type UpdateCheckRecord,
  type UpdaterCache,
  type UpdaterCacheStore,
} from './updater/selfUpdate'

const OUTPUT_CHANNEL_NAME = 'Oregan Policy Manager'
const UPDATER_STATE_KEY = 'updater'
const NOTICES_STATE_KEY = 'notices'
const READ_THE_POLICY = 'Read the policy'
const RELOAD_WINDOW = 'Reload Window'
const SHOW_DETAILS = 'Show Details'

/**
 * Entry point.  Only this module imports `vscode`: it builds the ports the policy modules take, wires them together
 * and registers the commands.  Everything slow is started without being awaited, so activation yields at once.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true })
  const host = detectHost(vscode.env.appName)
  const version = String(context.extension.packageJSON.version)
  const store = createSettingsStore()
  const registry = createExtensionRegistry()
  const updaterCache = createUpdaterCache(context)
  const notices = createNotices({
    logger: log,
    show: notice => showNotice(notice, log),
    store: createNoticeStore(context),
  })

  const remover = createCopilotRemover({
    logger: log,
    notifyRemoved: names => detach(log, 'Removal notification', showRemoved(names)),
    registry,
  })
  const onConfigurationChanged = createDriftHandler({
    afterFirstRestore(key, restored) {
      if (restored) notices.show(noticeForRestore(key))
      else detach(log, 'Drift notification', notices.forget(noticeForRestore(key)))
    },
    beforeFirstRestore: key => notices.save(noticeForRestore(key)),
    logger: log,
    store,
  })
  const updater = createUpdater({
    cache: updaterCache,
    currentVersion: version,
    install: installVsix,
    logger: log,
    onInstalled: installed => detach(log, 'Reload prompt', showReloadPrompt(installed)),
    storageDir: context.globalStorageUri.fsPath,
  })

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('oregan.showPolicyStatus', function showPolicyStatus() {
      const snapshot = collectStatusSnapshot({
        editorVersion: vscode.version,
        extensionVersion: version,
        host,
        lastUpdateCheck: updaterCache.get().lastCheck,
        pendingReload: remover.pendingReload(),
        registry,
        store,
      })
      log.info(`Policy status\n${formatStatusReport(snapshot)}`)
      log.show(true)
    }),
    vscode.commands.registerCommand('oregan.checkForUpdates', async function checkForUpdates() {
      showCheckResult(await updater.check({ force: true }), version, log)
    }),
    vscode.workspace.onDidChangeConfiguration(event =>
      detach(
        log,
        'Drift check',
        onConfigurationChanged(key => event.affectsConfiguration(key)),
      ),
    ),
    vscode.extensions.onDidChange(() => detach(log, 'Copilot removal', remover.run())),
  )

  log.info(`Oregan Policy Manager ${version} on ${host.name} ${vscode.version}`)

  /* Activation does no I/O itself: start-up and the first update check begin once activate() has returned */
  let schedule: { dispose(): void } | undefined
  const deferred = setImmediate(function startAfterActivation() {
    detach(log, 'Start-up', startUp())
    /*
     * The Extension Development Host and the integration suite run code that isn't a release, and isn't installed:
     * there is no release to follow and no install to apply to every profile.
     */
    if (context.extensionMode === vscode.ExtensionMode.Production) {
      detach(log, 'All profiles', applyToAllProfiles(createProfileScope(context, log)))
      schedule = scheduleChecks({ check: () => updater.check(), logger: log })
    } else {
      log.info('Update checks are off outside a release install - Oregan: Check for Updates still runs one')
    }
  })
  context.subscriptions.push({
    dispose() {
      clearImmediate(deferred)
      schedule?.dispose()
    },
  })

  async function startUp(): Promise<void> {
    notices.showSaved()
    // Saved before the write, which can restart the extension host when Copilot Chat is running
    const switchingOff = findAiSettingsOutOfLine(store).length > 0
    if (switchingOff) await notices.save(AI_SWITCHED_OFF)
    const switchedOff = findSwitchedOffAiSettings(await applyPolicy({ logger: log, store }))
    if (switchedOff.length) notices.show(AI_SWITCHED_OFF)
    else if (switchingOff) await notices.forget(AI_SWITCHED_OFF)
    await remover.run()
    const claudeCodeInstalled = registry.list().some(extension => extension.id.toLowerCase() === CLAUDE_CODE_ID)
    log.info(claudeCodeMessage({ cli: host.cli, installed: claudeCodeInstalled }).join('\n'))
    const hostWarning = aiFirstHostMessage(host)
    if (hostWarning.length) log.warn(hostWarning.join('\n'))
  }
}

/** Everything, including the update timer, is disposed through `context.subscriptions` */
export function deactivate(): void {}

/** Let a promise run without awaiting it, but still log a rejection rather than lose it */
function detach(log: vscode.LogOutputChannel, what: string, promise: Promise<unknown>): void {
  promise.catch((error: unknown) => log.error(`${what} failed: ${describeError(error)}`))
}

function createSettingsStore(): SettingsStore {
  return {
    inspect(key) {
      const configuration = vscode.workspace.getConfiguration()
      const inspection = configuration.inspect(key)
      if (!inspection) return undefined
      // inspect() has no field for device policy, but get() applies it
      return { ...inspection, effectiveValue: configuration.get(key), workspaceFolderValues: inspectFolders(key) }
    },
    async updateGlobal(key, value) {
      await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global)
    },
  }
}

/** Without a resource, inspect() leaves folder values out, so each folder of a multi-root workspace is asked in turn */
function inspectFolders(key: string): unknown[] {
  return (vscode.workspace.workspaceFolders ?? []).flatMap(folder => {
    const value = vscode.workspace.getConfiguration(undefined, folder.uri).inspect(key)?.workspaceFolderValue
    return value === undefined ? [] : [value]
  })
}

function createExtensionRegistry(): ExtensionRegistry {
  const builtInRoot = join(vscode.env.appRoot, 'extensions')
  return {
    list: () => vscode.extensions.all.map(extension => toInstalledExtension(extension, builtInRoot)),
    async uninstall(id) {
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id)
    },
  }
}

type ManifestFields = {
  displayName?: unknown
  extensionDependencies?: unknown
  isBuiltin?: unknown
}

function toInstalledExtension(extension: vscode.Extension<unknown>, builtInRoot: string): InstalledExtension {
  const manifest = (extension.packageJSON ?? {}) as ManifestFields
  const dependencies = Array.isArray(manifest.extensionDependencies) ? manifest.extensionDependencies : []
  return {
    /*
     * `isBuiltin` isn't public API, so the install location backs it up.  The editor also sets it on a marketplace copy
     * installed over a built-in, which lives with the user's extensions and whose uninstall is refused the same way.
     */
    builtIn: manifest.isBuiltin === true || isInside(extension.extensionPath, builtInRoot),
    dependencies: dependencies.filter((dependency): dependency is string => typeof dependency === 'string'),
    displayName: typeof manifest.displayName === 'string' ? manifest.displayName : extension.id,
    id: extension.id,
  }
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

/** The ports for {@link applyToAllProfiles}, over the extensions folder this install sits in */
function createProfileScope(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): ApplyToAllProfilesOptions {
  const { extensionPath, extensionUri } = context
  const { id } = context.extension
  // The default profile lists its extensions in the extensions folder; a named profile keeps its list elsewhere
  const manifestPath = join(dirname(extensionPath), 'extensions.json')
  return {
    isApplied: () => readAppliedToAllProfiles(manifestPath, id),
    logger: log,
    async toggle() {
      // The command on the gear menu, which finds the extension by the location it passes as context
      await vscode.commands.executeCommand('workbench.extensions.action.toggleApplyToAllProfiles', id, {
        location: extensionUri,
      })
    },
  }
}

/** Per window, and kept when the extension host restarts */
function createNoticeStore(context: vscode.ExtensionContext): NoticeStore {
  return {
    get: () => context.workspaceState.get<SavedNotice[]>(NOTICES_STATE_KEY),
    async set(value) {
      await context.workspaceState.update(NOTICES_STATE_KEY, value)
    },
  }
}

function createUpdaterCache(context: vscode.ExtensionContext): UpdaterCacheStore {
  return {
    get: () => context.globalState.get<UpdaterCache>(UPDATER_STATE_KEY) ?? {},
    async set(value) {
      await context.globalState.update(UPDATER_STATE_KEY, value)
    },
  }
}

async function installVsix(vsixPath: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath))
}

async function showRemoved(names: readonly string[]): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Oregan Policy Manager removed ${names.join(', ')}. GitHub Copilot isn't on Oregan's approved AI tool register.`,
    READ_THE_POLICY,
    RELOAD_WINDOW,
  )
  if (choice === READ_THE_POLICY) await vscode.env.openExternal(vscode.Uri.parse(IDE_CONFIGURATION_URL))
  // An extension that had already activated keeps running until the window reloads
  if (choice === RELOAD_WINDOW) await vscode.commands.executeCommand('workbench.action.reloadWindow')
}

async function showNotice(notice: Notice, log: vscode.LogOutputChannel): Promise<void> {
  switch (notice.kind) {
    case 'ai-switched-off':
      return showAiSwitchedOff(log)
    case 'setting-restored':
      return showRestored(notice.key)
  }
}

async function showAiSwitchedOff(log: vscode.LogOutputChannel): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Oregan Policy Manager switched off the editor's built-in AI and GitHub Copilot, as Oregan's Agentic AI " +
      'Development Policy requires. Claude Code is the approved assistant.',
    READ_THE_POLICY,
    SHOW_DETAILS,
  )
  if (choice === READ_THE_POLICY) await vscode.env.openExternal(vscode.Uri.parse(POLICY_URL))
  if (choice === SHOW_DETAILS) log.show(true)
}

async function showRestored(key: string): Promise<void> {
  await vscode.window.showInformationMessage(
    `Oregan Policy Manager set ${key} to the value Oregan's Agentic AI Development Policy requires. ` +
      'Details are in the Oregan Policy Manager output.',
  )
}

async function showReloadPrompt(version: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Oregan Policy Manager ${version} is installed. Reload the window to start using it.`,
    RELOAD_WINDOW,
  )
  if (choice === RELOAD_WINDOW) await vscode.commands.executeCommand('workbench.action.reloadWindow')
}

function showCheckResult(
  { detail, latestVersion, outcome }: UpdateCheckRecord,
  version: string,
  log: vscode.LogOutputChannel,
): void {
  switch (outcome) {
    case 'failed':
      void vscode.window.showWarningMessage(`Oregan Policy Manager could not check for updates: ${detail}`)
      return
    case 'up-to-date':
      // A release installed earlier this session counts as up to date, but only runs once the window reloads
      if (latestVersion && compareVersions(latestVersion, version) !== 0) {
        detach(log, 'Reload prompt', showReloadPrompt(latestVersion))
        return
      }
      void vscode.window.showInformationMessage(`Oregan Policy Manager ${version} is up to date.`)
      return
    case 'skipped':
      // Only when this call joined a timer check that found another window had the cycle
      void vscode.window.showInformationMessage('Another window is checking for Oregan Policy Manager updates.')
      return
    case 'installed':
      return // the reload prompt has already been shown
  }
}
