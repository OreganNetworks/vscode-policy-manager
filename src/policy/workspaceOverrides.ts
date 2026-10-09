/*
 * REQUIREMENT: Workspace overrides
 *
 * Warns while a workspace or folder setting overrides a managed setting, such as `chat.disableAIFeatures: false` in a
 * repository's `.vscode/settings.json`, which turns the built-in AI back on in that window.  The extension never writes
 * workspace or folder settings - they belong to the repository - so the warning is what makes the override seen: it
 * shows while the override lasts, and comes back when it is closed.
 */
import { type Logger } from '../logger'
import {
  isRegistered,
  isSettingEqual,
  MANAGED_SETTINGS,
  type ManagedSetting,
  type SettingInspection,
  type SettingsStore,
  type SettingValue,
} from './settings'

/** Where a value overriding the user setting lives */
export type SettingOverride = 'workspace' | 'workspace folder'

/** A workspace or folder value of a managed setting that disagrees with the policy */
export type WorkspaceOverride = {
  key: string
  scope: SettingOverride
  value: unknown
}

/** What the person who closed the warning chose, which sets how soon it comes back */
export type OverrideWarningAnswer = 'closed' | 'opened-settings'

/** Arguments to {@link createOverrideWarning} */
export type OverrideWarningOptions = {
  /** The overrides in this window now */
  find: () => readonly WorkspaceOverride[]
  logger: Logger
  /** Shows the warning, and resolves once it is closed */
  show: (overrides: readonly WorkspaceOverride[]) => Promise<OverrideWarningAnswer>
  /** How long a closed warning stays away while the override lasts */
  reshowMs?: number
  /** How long it stays away after **Open Workspace Settings**, for the setting to be removed */
  settingsMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** The warning for one window: see {@link createOverrideWarning} */
export type OverrideWarning = {
  /** Looks for overrides, and starts the warning when there are some and it isn't showing yet */
  check(): void
  /** Stops the warning coming back */
  dispose(): void
}

const RESHOW_MS = 2_000
const SETTINGS_MS = 30_000

/**
 * The workspace or folder value that overrides a managed setting, when one disagrees with the policy.  The workspace
 * value comes first: in a window with one folder, the editor reports the `.vscode/settings.json` of that folder as
 * both, and **Open Workspace Settings** opens it.
 *
 * @param expected    The policy value.
 * @param inspection  The setting, with the folder values of a multi-root workspace.
 * @returns Where the disagreeing value lives, and the value, or `undefined` when none disagrees.
 *
 * @example
 * findWorkspaceOverride(true, { workspaceValue: false }) // { scope: 'workspace', value: false }
 * findWorkspaceOverride(true, { workspaceValue: true }) // undefined
 */
export function findWorkspaceOverride(
  expected: SettingValue,
  inspection: SettingInspection | undefined,
): Omit<WorkspaceOverride, 'key'> | undefined {
  const { workspaceFolderValues = [], workspaceValue } = inspection ?? {}
  if (workspaceValue !== undefined && !isSettingEqual(workspaceValue, expected))
    return { scope: 'workspace', value: workspaceValue }
  const folder = workspaceFolderValues.find(value => !isSettingEqual(value, expected))
  return folder === undefined ? undefined : { scope: 'workspace folder', value: folder }
}

/**
 * Every managed setting that a workspace or folder setting overrides in this window.
 *
 * @param store     The settings, with workspace and folder values.
 * @param settings  The managed settings.
 * @returns The overrides, in the order of `settings`.
 */
export function findWorkspaceOverrides(
  store: SettingsStore,
  settings: readonly ManagedSetting[] = MANAGED_SETTINGS,
): WorkspaceOverride[] {
  return settings.flatMap(({ key, value }) => {
    const inspection = store.inspect(key)
    const found = isRegistered(inspection) ? findWorkspaceOverride(value, inspection) : undefined
    return found ? [{ key, ...found }] : []
  })
}

/**
 * The warning text.
 *
 * @param overrides  At least one.
 * @returns One sentence naming each override, and what to do.
 *
 * @example
 * overrideMessage([{ key: 'chat.disableAIFeatures', scope: 'workspace', value: false }])
 * // 'Oregan Policy Manager: this workspace sets chat.disableAIFeatures to false in its workspace settings, against
 * //  Oregan's Agentic AI Development Policy. Remove it from there; this message comes back until it is gone.'
 */
export function overrideMessage(overrides: readonly WorkspaceOverride[]): string {
  const list = overrides.map(({ key, scope, value }) => `${key} to ${JSON.stringify(value)} in its ${scope} settings`)
  const what = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]
  const [it, is] = overrides.length > 1 ? ['them', 'they are'] : ['it', 'it is']
  return (
    `Oregan Policy Manager: this workspace sets ${what}, against Oregan's Agentic AI Development Policy. ` +
    `Remove ${it} from there; this message comes back until ${is} gone.`
  )
}

/**
 * The warning for one window.  While there are overrides it shows the warning, and once that is closed, looks again
 * after `reshowMs` (or `settingsMs` after **Open Workspace Settings**) and shows it again if any are left.  The
 * output channel gets a warning each time the set of overrides changes.
 *
 * @param options  How to find the overrides and show the warning.
 * @returns The warning.
 */
export function createOverrideWarning({
  find,
  logger,
  reshowMs = RESHOW_MS,
  settingsMs = SETTINGS_MS,
  show,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}: OverrideWarningOptions): OverrideWarning {
  let showing = false
  let disposed = false
  let logged = ''

  function current(): readonly WorkspaceOverride[] {
    const overrides = find()
    const summary = overrides.map(({ key, scope, value }) => `${key} = ${JSON.stringify(value)} (${scope})`).join(', ')
    if (summary !== logged) {
      if (summary) logger.warn(`Workspace overrides: ${summary} - the extension never writes workspace settings`)
      else if (logged) logger.info('Workspace overrides: none any more')
      logged = summary
    }
    return overrides
  }

  async function keepShowing(): Promise<void> {
    showing = true
    try {
      for (let overrides = current(); overrides.length && !disposed; overrides = current()) {
        const answer = await show(overrides)
        await sleep(answer === 'opened-settings' ? settingsMs : reshowMs)
        if (disposed) break
      }
    } finally {
      showing = false
    }
  }

  return {
    check() {
      if (disposed) return
      if (showing) {
        current()
        return
      }
      keepShowing().catch((error: unknown) => logger.error(`Workspace override warning failed: ${String(error)}`))
    },
    dispose() {
      disposed = true
    },
  }
}
