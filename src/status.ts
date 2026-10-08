/*
 * REQUIREMENT: Policy status report
 *
 * What `Oregan: Show Policy Status` reports: each managed setting's value in effect, each managed extension, Claude
 * Code, the last update check and an overall verdict.
 */
import { type ExtensionRegistry, MANAGED_EXTENSIONS } from './policy/removeCopilotExtensions'
import { type HostInfo } from './host'
import {
  isRegistered,
  isSettingEqual,
  MANAGED_SETTINGS,
  type ManagedSetting,
  type SettingInspection,
  type SettingsStore,
  type SettingValue,
} from './policy/settings'
import { CLAUDE_CODE_ID } from './policy/recommendClaudeCode'
import { type UpdateCheckRecord } from './updater/selfUpdate'

/** Where a value overriding the user setting lives */
export type SettingOverride = 'workspace' | 'workspace folder'

/** One managed setting, as the status report shows it */
export type SettingStatus = {
  /**
   * Judged on the value in effect, so a key device policy locks to the policy value is compliant with no user value.
   * Unregistered keys count as compliant - there is nothing to switch off.
   */
  compliant: boolean
  expected: SettingValue
  /** The user value; `undefined` when unset */
  global: unknown
  key: string
  registered: boolean
  /** Set when a workspace or folder value disagrees with the policy - the extension never writes those */
  overriddenBy?: SettingOverride
}

/** One managed extension, as the status report shows it */
export type ManagedExtensionStatus = {
  builtIn: boolean
  /** Lower-case managed ID */
  id: string
  installed: boolean
  /** Uninstalled this session but still listed - it keeps running until the window reloads */
  pendingReload: boolean
}

/** Everything `Oregan: Show Policy Status` reports */
export type StatusSnapshot = {
  claudeCodeInstalled: boolean
  editorVersion: string
  extensionVersion: string
  extensions: ManagedExtensionStatus[]
  host: HostInfo
  settings: SettingStatus[]
  lastUpdateCheck?: UpdateCheckRecord
}

/** Inputs to {@link collectStatusSnapshot} - the same ports the policy modules use */
export type StatusSources = {
  editorVersion: string
  extensionVersion: string
  host: HostInfo
  registry: Pick<ExtensionRegistry, 'list'>
  store: Pick<SettingsStore, 'inspect'>
  lastUpdateCheck?: UpdateCheckRecord
  /** Lower-case IDs from the remover's `pendingReload()` */
  pendingReload?: readonly string[]
}

// Equal widths keep the report aligned
const TAG = { fail: '[FAIL]', notApplicable: '[n/a] ', ok: '[ok]  ', wait: '[wait]' }

/** Compare one setting's effective, workspace and folder values with the policy */
export function describeSetting(setting: ManagedSetting, inspection: SettingInspection | undefined): SettingStatus {
  const { key, value: expected } = setting
  const registered = isRegistered(inspection)
  const global = inspection?.globalValue
  const overriddenBy = findOverride(expected, inspection)
  const inEffect = mergeOverDefault(expected, inspection?.defaultValue)
  return {
    compliant: !registered || (isSettingEqual(inspection?.effectiveValue, inEffect) && !overriddenBy),
    expected,
    global,
    key,
    registered,
    ...(overriddenBy ? { overriddenBy } : {}),
  }
}

/** Build the status snapshot from the live ports */
export function collectStatusSnapshot({
  editorVersion,
  extensionVersion,
  host,
  lastUpdateCheck,
  pendingReload = [],
  registry,
  store,
}: StatusSources): StatusSnapshot {
  const installed = registry.list()
  const find = (id: string) => installed.find(extension => extension.id.toLowerCase() === id)
  return {
    claudeCodeInstalled: find(CLAUDE_CODE_ID) !== undefined,
    editorVersion,
    extensionVersion,
    extensions: MANAGED_EXTENSIONS.map(function describeExtension(id) {
      const match = find(id)
      return {
        builtIn: match?.builtIn ?? false,
        id,
        installed: match !== undefined,
        pendingReload: pendingReload.includes(id),
      }
    }),
    host,
    settings: MANAGED_SETTINGS.map(setting => describeSetting(setting, store.inspect(setting.key))),
    ...(lastUpdateCheck ? { lastUpdateCheck } : {}),
  }
}

/**
 * Compliant when every setting is in line and no managed extension is installed.  A built-in Copilot Chat can't be
 * removed, so it passes only while `chat.disableAIFeatures` is registered and on.
 */
export function isCompliant({ extensions, settings }: Pick<StatusSnapshot, 'extensions' | 'settings'>): boolean {
  return settings.every(status => status.compliant) && extensions.every(status => extensionCompliant(status, settings))
}

/** The status report text */
export function formatStatusReport(snapshot: StatusSnapshot): string {
  const { claudeCodeInstalled, editorVersion, extensionVersion, extensions, host, lastUpdateCheck, settings } = snapshot
  const claudeCode = claudeCodeInstalled
    ? 'installed'
    : `not installed - run \`${host.cli} --install-extension ${CLAUDE_CODE_ID}\``
  const lines = [
    `Oregan Policy Manager ${extensionVersion}`,
    `Editor: ${host.name} ${editorVersion} (CLI \`${host.cli}\`, extensions from ${host.extensionSource})`,
    `Overall: ${describeOverall(snapshot)}`,
    '',
    'User settings',
    ...settings.map(formatSetting),
    '',
    'Copilot extensions',
    ...extensions.map(status => formatExtension(status, settings)),
    '',
    `Claude Code: ${claudeCode}`,
    `Last update check: ${formatUpdateCheck(lastUpdateCheck)}`,
  ]
  if (host.aiFirst)
    lines.push(
      `Note: ${host.name}'s own built-in AI is outside this extension's reach and isn't on the approved register`,
    )
  return lines.join('\n')
}

/** The value in effect for `value` at user level - the editor merges an object setting over its default */
function mergeOverDefault(value: SettingValue, defaultValue: unknown): unknown {
  return isRecord(value) && isRecord(defaultValue) ? { ...defaultValue, ...value } : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findOverride(expected: SettingValue, inspection: SettingInspection | undefined): SettingOverride | undefined {
  const { workspaceFolderValues = [], workspaceValue } = inspection ?? {}
  if (workspaceFolderValues.some(value => !isSettingEqual(value, expected))) return 'workspace folder'
  if (workspaceValue !== undefined && !isSettingEqual(workspaceValue, expected)) return 'workspace'
  return undefined
}

/** A pending reload isn't compliant yet, but when it is all that is left, a reload is all the machine needs */
function describeOverall(snapshot: StatusSnapshot): string {
  if (isCompliant(snapshot)) return 'compliant'
  const { extensions, settings } = snapshot
  const onlyWaiting =
    settings.every(status => status.compliant) &&
    extensions.every(status => extensionCompliant(status, settings) || awaitingReload(status))
  return onlyWaiting ? 'reload the window to finish' : 'NOT compliant'
}

function extensionCompliant(
  { builtIn, installed }: ManagedExtensionStatus,
  settings: readonly SettingStatus[],
): boolean {
  if (!installed) return true
  const aiOff = settings.find(status => status.key === 'chat.disableAIFeatures')
  return builtIn && aiOff?.registered === true && aiOff.compliant
}

function awaitingReload({ builtIn, installed, pendingReload }: ManagedExtensionStatus): boolean {
  return installed && !builtIn && pendingReload
}

function formatSetting({ compliant, expected, global, key, overriddenBy, registered }: SettingStatus): string {
  if (!registered) return `  ${TAG.notApplicable} ${key} - not registered in this editor`
  const tag = compliant ? TAG.ok : TAG.fail
  if (overriddenBy) return `  ${tag} ${key} = ${show(global)}, overridden by a ${overriddenBy} setting`
  /*
   * With no disagreeing workspace value, a verdict that differs from the user value's means something outranks the
   * user value.  In practice that is device policy, which also refuses the user write that would bring them into line.
   */
  const userCompliant = isSettingEqual(global, expected)
  if (compliant && !userCompliant) return `  ${tag} ${key} = ${show(expected)} (set by device policy)`
  if (compliant) return `  ${tag} ${key} = ${show(global)}`
  if (userCompliant) return `  ${tag} ${key} = ${show(global)}, overridden by device policy`
  return `  ${tag} ${key} = ${show(global)} (policy: ${show(expected)})`
}

function formatExtension(status: ManagedExtensionStatus, settings: readonly SettingStatus[]): string {
  const compliant = extensionCompliant(status, settings)
  const tag = compliant ? TAG.ok : TAG.fail
  // `vscode.extensions.all` leaves out disabled extensions, and a built-in one hidden once AI features are off
  if (!status.installed) return `  ${tag} ${status.id} - not installed or disabled`
  if (status.builtIn && compliant) return `  ${tag} ${status.id} - built in, switched off by chat.disableAIFeatures`
  if (status.builtIn) return `  ${tag} ${status.id} - built in, and chat.disableAIFeatures is not on`
  if (awaitingReload(status)) return `  ${TAG.wait} ${status.id} - uninstalled, reload the window to finish`
  return `  ${tag} ${status.id} - installed`
}

function formatUpdateCheck(record: UpdateCheckRecord | undefined): string {
  if (!record) return 'not yet'
  return `${new Date(record.at).toISOString()} - ${record.outcome}: ${record.detail}`
}

function show(value: unknown): string {
  return value === undefined ? 'unset' : JSON.stringify(value)
}
