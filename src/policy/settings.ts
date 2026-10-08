/*
 * REQUIREMENT: Telemetry off
 * REQUIREMENT: Built-in AI and GitHub Copilot settings off
 *
 * The managed user settings, and bringing them into line at user level.  Each key is written with
 * `ConfigurationTarget.Global` only, and a key the editor hasn't registered is skipped, so one VSIX works across editor
 * versions and forks.
 */
import { describeError, type Logger } from '../logger'

/** A JSON value, which is all a setting can hold */
export type SettingValue = boolean | number | string | null | SettingValue[] | { [key: string]: SettingValue }

/**
 * A user setting the extension owns.  Third-party telemetry flags sit in the same table, {@link MANAGED_SETTINGS}, so
 * adding one is a one-line change.
 */
export type ManagedSetting = {
  /** `telemetry` for telemetry flags, `ai` for built-in AI and Copilot */
  group: 'ai' | 'telemetry'
  key: string
  /** The value the policy requires */
  value: SettingValue
}

/**
 * Keys and values match the IDE Configuration page.  `chat.disableAIFeatures` is the master switch for the editor's
 * built-in AI (and the only thing that turns off the built-in Copilot Chat in VS Code 1.138+); `github.copilot.enable`
 * covers editors that predate it.  Neither affects Claude Code, which sits outside the built-in AI surface.
 */
export const MANAGED_SETTINGS: readonly ManagedSetting[] = [
  { group: 'telemetry', key: 'telemetry.telemetryLevel', value: 'off' },
  { group: 'telemetry', key: 'redhat.telemetry.enabled', value: false },
  { group: 'ai', key: 'chat.disableAIFeatures', value: true },
  { group: 'ai', key: 'github.copilot.enable', value: { '*': false } },
]

/**
 * The subset of `WorkspaceConfiguration.inspect()` the policy reads, plus the value in effect.  Where device policy
 * sets a key, the editor reports the policy's value as `defaultValue` and `effectiveValue`, and refuses a user write.
 */
export type SettingInspection = {
  defaultValue?: unknown
  /** `WorkspaceConfiguration.get()` - what the editor actually uses, device policy included */
  effectiveValue?: unknown
  /** The user (global) value - the only one the policy writes */
  globalValue?: unknown
  /**
   * `workspaceFolderValue` from each folder of a multi-root workspace that sets one.  The editor only reports a folder
   * value it applies, so a window- or application-scoped key never has one.
   */
  workspaceFolderValues?: readonly unknown[]
  workspaceValue?: unknown
}

/**
 * Port over `vscode.workspace.getConfiguration()`, so the policy runs under node:test.  The real one in
 * `extension.ts` writes with `ConfigurationTarget.Global` and nothing else.
 */
export type SettingsStore = {
  inspect(key: string): SettingInspection | undefined
  /** Write the user value.  Rejects when the editor refuses, e.g. a key locked by device policy */
  updateGlobal(key: string, value: SettingValue): Promise<void>
}

/** What happened to one managed setting */
export type ApplyResult = {
  key: string
  state: 'applied' | 'failed' | 'unchanged' | 'unregistered'
  /** Set when `state` is `failed` */
  error?: string
}

/** Arguments to {@link applySetting} */
export type ApplySettingOptions = {
  logger: Logger
  setting: ManagedSetting
  store: SettingsStore
}

/** Arguments to {@link applyPolicy} */
export type ApplyPolicyOptions = {
  logger: Logger
  store: SettingsStore
  /** Defaults to {@link MANAGED_SETTINGS} */
  settings?: readonly ManagedSetting[]
}

/**
 * VS Code rejects `update()` for a key no installed component has registered.  A registered key always has a default
 * (VS Code derives one from the schema type when the contributor gives none), so a missing default means
 * unregistered.
 */
export function isRegistered(inspection: SettingInspection | undefined): boolean {
  return inspection?.defaultValue !== undefined
}

/** Deep equality for setting values.  Object key order doesn't matter; array order does. */
export function isSettingEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  if (aKeys.length !== Object.keys(bRecord).length) return false
  return aKeys.every(key => Object.hasOwn(bRecord, key) && isSettingEqual(aRecord[key], bRecord[key]))
}

/**
 * Bring one managed setting into line at user level.  Never throws - a refused write comes back as `failed`, or as
 * `unchanged` when device policy already enforces the policy value.
 */
export async function applySetting({ logger, setting, store }: ApplySettingOptions): Promise<ApplyResult> {
  const { key, value } = setting
  const inspection = store.inspect(key)
  if (!isRegistered(inspection)) {
    logger.info(`${key}: not registered in this editor, skipped`)
    return { key, state: 'unregistered' }
  }
  if (isSettingEqual(inspection?.globalValue, value)) return { key, state: 'unchanged' }
  try {
    await store.updateGlobal(key, value)
    logger.info(`${key}: set to ${JSON.stringify(value)}`)
    return { key, state: 'applied' }
  } catch (error: unknown) {
    if (isSettingEqual(inspection?.effectiveValue, value)) {
      logger.info(`${key}: already enforced by device policy`)
      return { key, state: 'unchanged' }
    }
    const message = describeError(error)
    logger.warn(`${key}: could not be written - ${message}`)
    return { error: message, key, state: 'failed' }
  }
}

/**
 * The AI settings an apply wrote, so the start-up notification goes out only when the policy has just switched
 * something off.  On later start-ups every AI setting is already in line, and the list is empty.
 *
 * @param results   From {@link applyPolicy}.
 * @param settings  Defaults to {@link MANAGED_SETTINGS}.
 * @returns The keys from the `ai` group whose state is `applied`, in `results` order.
 *
 * @example
 * findSwitchedOffAiSettings([
 *   { key: 'telemetry.telemetryLevel', state: 'applied' },
 *   { key: 'chat.disableAIFeatures', state: 'applied' },
 *   { key: 'github.copilot.enable', state: 'unchanged' },
 * ])
 * // ['chat.disableAIFeatures']
 */
export function findSwitchedOffAiSettings(
  results: readonly ApplyResult[],
  settings: readonly ManagedSetting[] = MANAGED_SETTINGS,
): string[] {
  const aiKeys = new Set(settings.filter(setting => setting.group === 'ai').map(setting => setting.key))
  return results.filter(result => result.state === 'applied' && aiKeys.has(result.key)).map(result => result.key)
}

/**
 * Bring every managed setting into line at user level.  Writes go one at a time - each one rewrites
 * the user `settings.json`, and concurrent writes to that file can fail.
 */
export async function applyPolicy({
  logger,
  settings = MANAGED_SETTINGS,
  store,
}: ApplyPolicyOptions): Promise<ApplyResult[]> {
  const results: ApplyResult[] = []
  for (const setting of settings) results.push(await applySetting({ logger, setting, store }))
  return results
}
