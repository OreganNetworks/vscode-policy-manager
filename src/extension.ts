import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import * as vscode from 'vscode'
import {
  applyToAllProfiles,
  type ApplyToAllProfilesOptions,
  type ProfileScopeOutcome,
  readAppliedToAllProfiles,
} from './policy/applyToAllProfiles'
import { IGNORED_EXTENSIONS_KEY, IGNORED_SETTINGS_KEY, keepOutOfSync } from './policy/keepOutOfSync'
import {
  createCopilotRemover,
  type ExtensionRegistry,
  type InstalledExtension,
  MANAGED_EXTENSIONS,
} from './policy/removeCopilotExtensions'
import {
  admitStartUpRestores,
  createBurstGuard,
  createDriftHandler,
  createFileBurstStore,
  DRIFT_BURST,
} from './policy/keepSettings'
import { aiFirstHostMessage, detectHost, type HostInfo } from './host'
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
import { cliInstallCommand, runCliInstall } from './updater/cliInstall'
import { compareVersions } from './updater/manifest'
import {
  applyPolicy,
  findAiSettingsOutOfLine,
  findSwitchedOffAiSettings,
  MANAGED_SETTINGS,
  type SettingsStore,
} from './policy/settings'
import { CLAUDE_CODE_ID, claudeCodeMessage } from './policy/recommendClaudeCode'
import { createSettingsLock } from './settingsLock'
import { isSetupWindow } from './setupWindow'
import {
  createOverrideWarning,
  findWorkspaceOverrides,
  type OverrideWarningAnswer,
  overrideMessage,
  overridesAi,
  type WorkspaceOverride,
} from './policy/workspaceOverrides'
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
const DRIFT_RESTORES_FILE = 'drift-restores.json'
const SETTINGS_LOCK_FILE = 'settings-write.lock'
const READ_THE_POLICY = 'Read the policy'
const RELOAD_WINDOW = 'Reload Window'
const SHOW_DETAILS = 'Show Details'
const OPEN_WORKSPACE_SETTINGS = 'Open Workspace Settings'

/**
 * Entry point.  Only this module imports `vscode`: it builds the ports the policy modules take, wires them together
 * and registers the commands.  Everything slow is started without being awaited, so activation yields at once.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true })
  const host = detectHost(vscode.env.appName)
  const version = String(context.extension.packageJSON.version)
  // Every write to user settings goes through the lock, one window at a time (see settingsLock.ts)
  const settingsLock = createSettingsLock({
    logger: log,
    path: join(context.globalStorageUri.fsPath, SETTINGS_LOCK_FILE),
  })
  const store = settingsLock.track(createSettingsStore())
  const registry = createExtensionRegistry()
  const updaterCache = createUpdaterCache(context)
  const syncExclusions = {
    // This extension too: extension sync must not install a Marketplace extension with its ID on another machine
    extensionIds: [...MANAGED_EXTENSIONS, context.extension.id],
    logger: log,
    settingKeys: MANAGED_SETTINGS.map(setting => setting.key),
    store,
  }
  const notices = createNotices({
    logger: log,
    show: notice => showNotice({ log, notice, store }),
    store: createNoticeStore(context),
  })

  const remover = createCopilotRemover({
    logger: log,
    notifyRemoved: names => detach(log, 'Removal notification', showRemoved(names, log)),
    registry,
  })
  // Read and written by start-up and the drift handler, which both run under the settings lock, so every window reads
  // the same count
  const driftGuard = createBurstGuard({
    ...DRIFT_BURST,
    store: createFileBurstStore({ logger: log, path: join(context.globalStorageUri.fsPath, DRIFT_RESTORES_FILE) }),
  })
  const onConfigurationChanged = createDriftHandler({
    afterFirstRestore(key, restored) {
      if (restored) notices.show(noticeForRestore(key))
      else detach(log, 'Drift notification', notices.forget(noticeForRestore(key)))
    },
    beforeFirstRestore: key => notices.save(noticeForRestore(key)),
    guard: driftGuard,
    logger: log,
    store,
  })
  // Per window: the workspace settings belong to this window's folder or workspace
  const overrideWarning = createOverrideWarning({
    find: () => findWorkspaceOverrides(store),
    logger: log,
    show: overrides => showOverrideWarning(overrides, log),
  })
  const updater = createUpdater({
    cache: updaterCache,
    currentVersion: version,
    install: vsixPath => installVsix({ context, host, log, vsixPath }),
    logger: log,
    onInstalled: installed => detach(log, 'Reload prompt', showReloadPrompt(installed, log)),
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
    vscode.workspace.onDidChangeConfiguration(event => {
      const affects = (key: string) => event.affectsConfiguration(key)
      detach(
        log,
        'Drift check',
        settingsLock.run('Drift check', () => onConfigurationChanged(affects)),
      )
      if (affects(IGNORED_SETTINGS_KEY) || affects(IGNORED_EXTENSIONS_KEY))
        detach(
          log,
          'Settings Sync lists',
          settingsLock.run('Settings Sync lists', () => keepOutOfSync(syncExclusions)),
        )
      overrideWarning.check()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => overrideWarning.check()),
    vscode.extensions.onDidChange(() => detach(log, 'Copilot removal', remover.run())),
  )

  log.info(`Oregan Policy Manager ${version} on ${host.name} ${vscode.version}`)

  /* Activation does no I/O itself: start-up and the first update check begin once activate() has returned */
  let schedule: { dispose(): void } | undefined
  const deferred = setImmediate(function startAfterActivation() {
    const startedUp = startUp()
    detach(log, 'Start-up', startedUp)
    /*
     * The Extension Development Host and the integration suite run code that isn't a release, and isn't installed:
     * there is no release to follow and no install to apply to every profile.
     */
    if (context.extensionMode === vscode.ExtensionMode.Production) {
      const applied = applyToAllProfiles(createProfileScope(context, log))
      detach(
        log,
        'Setup window',
        applied.then(outcome => closeIfSetupWindow(outcome, startedUp, log)),
      )
      schedule = scheduleChecks({ check: () => updater.check(), logger: log })
    } else {
      log.info('Update checks are off outside a release install - Oregan: Check for Updates still runs one')
    }
  })
  context.subscriptions.push({
    dispose() {
      clearImmediate(deferred)
      schedule?.dispose()
      detach(log, 'Settings lock', settingsLock.dispose())
      overrideWarning.dispose()
    },
  })

  async function startUp(): Promise<void> {
    notices.showSaved()
    await settingsLock.run('Start-up', applySettings)
    overrideWarning.check()
    // Every window, as extensions are per profile, and the editor queues the uninstalls
    await remover.run()
    const claudeCodeInstalled = registry.list().some(extension => extension.id.toLowerCase() === CLAUDE_CODE_ID)
    log.info(claudeCodeMessage({ cli: host.cli, installed: claudeCodeInstalled }).join('\n'))
    const hostWarning = aiFirstHostMessage(host)
    if (hostWarning.length) log.warn(hostWarning.join('\n'))
  }

  /** The settings part of start-up, run under the settings lock: a window that waited for it finds nothing to write */
  async function applySettings(): Promise<void> {
    // Before the policy writes anything, so none of it goes to the other machines on the sync account
    await keepOutOfSync(syncExclusions)
    const settings = await admitStartUpRestores({ guard: driftGuard, logger: log, store })
    // Saved before the write, which can restart the extension host when Copilot Chat is running
    const switchingOff = findAiSettingsOutOfLine(store, settings).length > 0
    if (switchingOff) await notices.save(AI_SWITCHED_OFF)
    const switchedOff = findSwitchedOffAiSettings(await applyPolicy({ logger: log, settings, store }))
    if (switchedOff.length) notices.show(AI_SWITCHED_OFF)
    else if (switchingOff) await notices.forget(AI_SWITCHED_OFF)
  }
}

/**
 * Closes the window an install opened only for the extension to apply itself to all profiles (see `setupWindow.ts`),
 * once it has, and once start-up has written the policy, so no write is cut short.  A window where it could not apply
 * itself stays open, with the setup file saying where to look.
 */
async function closeIfSetupWindow(
  outcome: ProfileScopeOutcome,
  startedUp: Promise<void>,
  log: vscode.LogOutputChannel,
): Promise<void> {
  if (outcome !== 'applied' && outcome !== 'already') return
  const documents = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file')
  const folderCount = vscode.workspace.workspaceFolders?.length ?? 0
  if (!isSetupWindow({ documents: documents.map(document => document.uri.fsPath), folderCount })) return
  await startedUp.catch(() => undefined)
  log.info('Setup window: applied to all profiles, so the window the install opened closes again')
  await vscode.commands.executeCommand('workbench.action.closeWindow')
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

/** Arguments to {@link installVsix} */
type InstallVsixOptions = {
  context: vscode.ExtensionContext
  host: HostInfo
  log: vscode.LogOutputChannel
  vsixPath: string
}

/**
 * Installs an update with the editor CLI, into the default profile, so it reaches every profile whichever window has
 * the cycle (see `updater/cliInstall.ts`).  An editor whose CLI isn't where VS Code keeps it gets the install command
 * instead, which only updates the profile of this window when that is a named one.
 */
async function installVsix({ context, host, log, vsixPath }: InstallVsixOptions): Promise<void> {
  const command = cliInstallCommand({
    appRoot: vscode.env.appRoot,
    cli: host.cli,
    execPath: process.execPath,
    exists: existsSync,
    extensionPath: context.extensionPath,
    globalStoragePath: context.globalStorageUri.fsPath,
    platform: process.platform,
    vsixPath,
  })
  if (command) {
    log.debug(`Update: ${await runCliInstall(command)}`)
    return
  }
  log.warn(
    `Update: no ${host.cli} CLI where the editor keeps it, so it installs through the editor - from a window with a ` +
      'named profile, only that profile gets the update',
  )
  await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath))
}

/**
 * Shows an information message, and logs it and the answer, so the output channel records every notification.
 *
 * @param log      The output channel.
 * @param message  The message.
 * @param items    The buttons.
 * @returns The button chosen, or `undefined` when the notification was closed.
 */
async function notify(log: vscode.LogOutputChannel, message: string, ...items: string[]): Promise<string | undefined> {
  log.info(`Notification: ${message}`)
  const choice = await vscode.window.showInformationMessage(message, ...items)
  log.info(`Notification: ${choice === undefined ? 'closed' : `${choice} chosen`}`)
  return choice
}

/**
 * The warning for a workspace override (see `policy/workspaceOverrides.ts`): an error message, so it stays on screen
 * until it is closed, as the editor hides other notifications with buttons after a while.
 */
async function showOverrideWarning(
  overrides: readonly WorkspaceOverride[],
  log: vscode.LogOutputChannel,
): Promise<OverrideWarningAnswer> {
  const message = overrideMessage(overrides)
  log.info(`Notification: ${message}`)
  const choice = await vscode.window.showErrorMessage(message, OPEN_WORKSPACE_SETTINGS, READ_THE_POLICY)
  log.info(`Notification: ${choice === undefined ? 'closed' : `${choice} chosen`}`)
  if (choice === READ_THE_POLICY) await vscode.env.openExternal(vscode.Uri.parse(POLICY_URL))
  if (choice !== OPEN_WORKSPACE_SETTINGS) return 'closed'
  // A folder setting of a multi-root workspace is in that folder's settings; the editor asks which folder
  const inWorkspace = overrides.some(override => override.scope === 'workspace')
  await vscode.commands.executeCommand(
    inWorkspace ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openFolderSettingsFile',
  )
  return 'opened-settings'
}

async function showRemoved(names: readonly string[], log: vscode.LogOutputChannel): Promise<void> {
  const choice = await notify(
    log,
    `Oregan Policy Manager removed ${names.join(', ')}. GitHub Copilot isn't on Oregan's approved AI tool register.`,
    READ_THE_POLICY,
    RELOAD_WINDOW,
  )
  if (choice === READ_THE_POLICY) await vscode.env.openExternal(vscode.Uri.parse(IDE_CONFIGURATION_URL))
  // An extension that had already activated keeps running until the window reloads
  if (choice === RELOAD_WINDOW) await vscode.commands.executeCommand('workbench.action.reloadWindow')
}

/** Arguments to {@link showNotice} */
type ShowNoticeOptions = {
  log: vscode.LogOutputChannel
  notice: Notice
  store: SettingsStore
}

async function showNotice({ log, notice, store }: ShowNoticeOptions): Promise<void> {
  switch (notice.kind) {
    case 'ai-switched-off':
      /*
       * A workspace setting that turns the AI on starts Copilot Chat, which registers its settings, and the policy then
       * writes them at user level.  The AI stays on in this window all the same, and the override warning says why.
       */
      if (overridesAi(findWorkspaceOverrides(store))) {
        log.info('No AI notification: a workspace setting keeps the built-in AI on in this window')
        return
      }
      return showAiSwitchedOff(log)
    case 'setting-restored':
      return showRestored(notice.key, log)
  }
}

async function showAiSwitchedOff(log: vscode.LogOutputChannel): Promise<void> {
  const choice = await notify(
    log,
    "Oregan Policy Manager switched off the editor's built-in AI and GitHub Copilot, as Oregan's Agentic AI " +
      'Development Policy requires. Claude Code is the approved assistant.',
    READ_THE_POLICY,
    SHOW_DETAILS,
  )
  if (choice === READ_THE_POLICY) await vscode.env.openExternal(vscode.Uri.parse(POLICY_URL))
  if (choice === SHOW_DETAILS) log.show(true)
}

async function showRestored(key: string, log: vscode.LogOutputChannel): Promise<void> {
  await notify(
    log,
    `Oregan Policy Manager set ${key} to the value Oregan's Agentic AI Development Policy requires. ` +
      'Details are in the Oregan Policy Manager output.',
  )
}

async function showReloadPrompt(version: string, log: vscode.LogOutputChannel): Promise<void> {
  const choice = await notify(
    log,
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
        detach(log, 'Reload prompt', showReloadPrompt(latestVersion, log))
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
