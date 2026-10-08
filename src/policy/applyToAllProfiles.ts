/*
 * REQUIREMENT: Every profile
 *
 * Applies the extension to all profiles, so the policy runs in every window whatever profile it uses.  VS Code has no
 * manifest field or install option for this, only **Apply Extension to all Profiles** on the gear menu of the
 * extension.  That command toggles, and the API can't read the state it toggles, so the state comes from the
 * `extensions.json` of the default profile.
 */
import { readFile } from 'node:fs/promises'
import { describeError, type Logger } from '../logger'

/*
 * VS Code 1.90 ignores the command until the workbench has loaded its list of installed extensions, which can be after
 * this extension activates.  The command only returns once it has written `extensions.json`, so a state that still
 * reads as not applied means it was ignored, and trying again is safe.
 */
const RETRY_DELAYS_MS = [5_000, 30_000]

/** How {@link applyToAllProfiles} ended */
export type ProfileScopeOutcome = 'already' | 'applied' | 'failed' | 'unknown'

/** Arguments to {@link applyToAllProfiles} */
export type ApplyToAllProfilesOptions = {
  /** Whether the extension is applied to all profiles; `undefined` when that can't be told.  Never rejects. */
  isApplied: () => Promise<boolean | undefined>
  logger: Logger
  /** `workbench.extensions.action.toggleApplyToAllProfiles` - it turns the scope off again when it is on */
  toggle: () => Promise<void>
  /** Waits before each retry of a toggle the editor ignored.  Defaults to 5 and 30 seconds */
  retryDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

/** The part of an `extensions.json` entry that says whether the extension is applied to all profiles */
type ManifestEntry = {
  identifier?: { id?: unknown }
  metadata?: { isApplicationScoped?: unknown }
}

/**
 * Reads whether an extension is applied to all profiles from the `extensions.json` of the default profile, which sits
 * in the extensions folder beside the extension folders.  An extension applied to all profiles is always listed there,
 * so one that isn't listed - installed into a named profile only - is not applied.
 *
 * @param manifestPath  The `extensions.json` in the extensions folder.
 * @param id            The extension ID, compared case-insensitively.
 * @returns True when the entry has `metadata.isApplicationScoped`, false when it hasn't or there is no entry, and
 *          `undefined` when the file can't be read or isn't the list the editor writes.
 *
 * @example
 * // extensions.json: [{ "identifier": { "id": "oregannetworks.oregan-policy-manager" },
 * //                     "metadata": { "isApplicationScoped": true, "pinned": true, "source": "vsix" } }]
 * await readAppliedToAllProfiles('/home/me/.vscode/extensions/extensions.json', 'oregannetworks.oregan-policy-manager')
 * // true
 */
export async function readAppliedToAllProfiles(manifestPath: string, id: string): Promise<boolean | undefined> {
  let entries: unknown
  try {
    entries = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
  if (!Array.isArray(entries)) return undefined
  const target = id.toLowerCase()
  const match = (entries as ManifestEntry[]).find(
    entry => typeof entry?.identifier?.id === 'string' && entry.identifier.id.toLowerCase() === target,
  )
  return match?.metadata?.isApplicationScoped === true
}

/**
 * Turns **Apply Extension to all Profiles** on unless it is already on, reading the state back after each toggle and
 * trying again after a delay when the editor ignored it.  The state is read before every toggle, so one that reads as
 * applied is never toggled off.  Run once a session, so a developer who turns it off finds it on again in the next
 * window.  Never throws: an editor without the command (a fork, or a later VS Code that drops it) is logged and left
 * as it is.
 */
export async function applyToAllProfiles({
  isApplied,
  logger,
  retryDelaysMs = RETRY_DELAYS_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  toggle,
}: ApplyToAllProfilesOptions): Promise<ProfileScopeOutcome> {
  const before = await isApplied()
  if (before === undefined) return cannotTell(logger)
  if (before) {
    logger.debug('All profiles: already applied to all profiles')
    return 'already'
  }
  for (const [attempt, delayMs] of [0, ...retryDelaysMs].entries()) {
    if (attempt) {
      logger.debug(`All profiles: the editor ignored the command, trying again in ${delayMs / 1000} seconds`)
      await sleep(delayMs)
      const now = await isApplied()
      if (now === undefined) return cannotTell(logger)
      if (now) return applied(logger)
    }
    try {
      await toggle()
    } catch (error: unknown) {
      logger.warn(`All profiles: could not apply this extension to all profiles - ${describeError(error)} (ignored)`)
      return 'failed'
    }
    if (await isApplied()) return applied(logger)
  }
  logger.warn('All profiles: the command ran, but this extension is still not applied to all profiles')
  return 'failed'
}

function applied(logger: Logger): ProfileScopeOutcome {
  logger.info('Applied to all profiles, so the policy runs in every window whatever its profile')
  return 'applied'
}

function cannotTell(logger: Logger): ProfileScopeOutcome {
  logger.info('All profiles: could not read whether this extension is applied to all profiles, left as it is')
  return 'unknown'
}
