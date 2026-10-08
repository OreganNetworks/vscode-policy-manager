/*
 * REQUIREMENT: Out of Settings Sync
 *
 * Keeps the managed settings and extensions out of Settings Sync.  Without it, the policy values and the Copilot
 * uninstalls go to every machine on the sync account of the developer, and a change made on another machine comes
 * back here, where the drift handler fights it - and switching the AI back off restarts the extension host.
 */
import { describeError, type Logger } from '../logger'
import { isRegistered, type SettingsStore } from './settings'

/** The setting keys Settings Sync leaves out */
export const IGNORED_SETTINGS_KEY = 'settingsSync.ignoredSettings'
/** The extension IDs Settings Sync leaves out */
export const IGNORED_EXTENSIONS_KEY = 'settingsSync.ignoredExtensions'

/** Options for {@link addMissingEntries} */
export type AddMissingEntriesOptions = {
  /** Compare case-insensitively, as for extension IDs */
  ignoreCase?: boolean
}

/** Arguments to {@link keepOutOfSync} */
export type KeepOutOfSyncOptions = {
  /** The managed extensions, and this extension */
  extensionIds: readonly string[]
  logger: Logger
  /** The managed setting keys */
  settingKeys: readonly string[]
  store: SettingsStore
}

/**
 * A Settings Sync list with `required` added.  The developer's own entries are kept, except a `-<key>` entry, which
 * asks Settings Sync to sync a key it would otherwise leave out.
 *
 * @param current   The user value of the list; anything but an array counts as empty.
 * @param required  The entries the list must have.
 * @param options   `ignoreCase` for extension IDs.
 * @returns The list to write, or `undefined` when it already has every entry.
 *
 * @example
 * addMissingEntries(['editor.fontSize', '-chat.disableAIFeatures'], ['chat.disableAIFeatures'])
 * // ['editor.fontSize', 'chat.disableAIFeatures']
 */
export function addMissingEntries(
  current: unknown,
  required: readonly string[],
  { ignoreCase = false }: AddMissingEntriesOptions = {},
): string[] | undefined {
  const fold = (value: string) => (ignoreCase ? value.toLowerCase() : value)
  const wanted = new Set(required.map(fold))
  const list = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === 'string') : []
  const kept = list.filter(entry => !(entry.startsWith('-') && wanted.has(fold(entry.slice(1)))))
  const present = new Set(kept.map(fold))
  const missing = required.filter(entry => !present.has(fold(entry)))
  if (!missing.length && kept.length === list.length && Array.isArray(current)) return undefined
  return [...kept, ...missing]
}

/**
 * Adds the managed setting keys and extension IDs to the two Settings Sync lists, at user level, where they are
 * missing.  An editor without Settings Sync has neither key registered, and is skipped.  Never throws.
 */
export async function keepOutOfSync({ extensionIds, logger, settingKeys, store }: KeepOutOfSyncOptions): Promise<void> {
  await addEntries({ key: IGNORED_SETTINGS_KEY, logger, required: settingKeys, store })
  await addEntries({ ignoreCase: true, key: IGNORED_EXTENSIONS_KEY, logger, required: extensionIds, store })
}

type AddEntriesOptions = {
  key: string
  logger: Logger
  required: readonly string[]
  store: SettingsStore
  ignoreCase?: boolean
}

async function addEntries({ ignoreCase, key, logger, required, store }: AddEntriesOptions): Promise<void> {
  const inspection = store.inspect(key)
  if (!isRegistered(inspection)) {
    logger.info(`${key}: not registered in this editor, skipped`)
    return
  }
  const next = addMissingEntries(inspection?.globalValue, required, { ignoreCase })
  if (!next) return
  try {
    await store.updateGlobal(key, next)
    logger.info(
      `${key}: left the managed ${key === IGNORED_SETTINGS_KEY ? 'settings' : 'extensions'} out of Settings Sync`,
    )
  } catch (error: unknown) {
    logger.warn(`${key}: could not be written - ${describeError(error)}`)
  }
}
