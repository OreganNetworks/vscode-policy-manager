/*
 * REQUIREMENT: Keeping settings in place
 *
 * Puts a managed user setting back when something changes it away from the policy value, and writes a key that an
 * extension installed after start-up registers.  Workspace and folder values are never written - the status report
 * shows an override instead.
 */
import { type Logger } from '../logger'
import {
  applySetting,
  isRegistered,
  isSettingEqual,
  MANAGED_SETTINGS,
  type ManagedSetting,
  type SettingsStore,
} from './settings'

/** Outcome of {@link BurstGuard.check} */
export type BurstDecision = 'allowed' | 'suspended' | 'suspended-now'

/**
 * Stops the drift handler fighting another writer indefinitely.  A key restored `limit` times inside `windowMs` is
 * left alone for the rest of the session: something keeps rewriting it, and a restore loop would thrash
 * `settings.json` without ever winning.
 */
export type BurstGuard = {
  /** `suspended-now` is returned once, when the key is suspended, so the caller can log it once */
  check(key: string, now: number): BurstDecision
}

/** Arguments to {@link createBurstGuard} */
export type BurstGuardOptions = {
  limit: number
  windowMs: number
}

const DRIFT_BURST: BurstGuardOptions = { limit: 5, windowMs: 10_000 } // 5 restores in 10 seconds is a fight, not a user

/** Build a {@link BurstGuard} */
export function createBurstGuard({ limit, windowMs }: BurstGuardOptions): BurstGuard {
  const history = new Map<string, number[]>()
  const suspended = new Set<string>()
  return {
    check(key, now) {
      if (suspended.has(key)) return 'suspended'
      const recent = (history.get(key) ?? []).filter(at => now - at < windowMs)
      if (recent.length >= limit) {
        suspended.add(key)
        history.delete(key)
        return 'suspended-now'
      }
      recent.push(now)
      history.set(key, recent)
      return 'allowed'
    },
  }
}

/** Handler for `workspace.onDidChangeConfiguration`, given the event's `affectsConfiguration` */
export type DriftHandler = (affects: (key: string) => boolean) => Promise<void>

/** Arguments to {@link createDriftHandler} */
export type DriftHandlerOptions = {
  logger: Logger
  /** Called for the first restore of the session only - the policy allows one message per session */
  onFirstRestore: (key: string) => void
  store: SettingsStore
  guard?: BurstGuard
  now?: () => number
  settings?: readonly ManagedSetting[]
}

/**
 * Put a managed setting back when its user value drifts from the policy.  Also picks up a key that becomes
 * registered after start-up, e.g. when a Red Hat extension is installed, because registration fires the same event.
 *
 * Only the user value is checked.  A workspace override is reported by the status command but never written -
 * workspace settings belong to the repository.
 */
export function createDriftHandler({
  guard = createBurstGuard(DRIFT_BURST),
  logger,
  now = Date.now,
  onFirstRestore,
  settings = MANAGED_SETTINGS,
  store,
}: DriftHandlerOptions): DriftHandler {
  let reported = false
  return async function onConfigurationChanged(affects) {
    for (const setting of settings) {
      if (!affects(setting.key)) continue
      const inspection = store.inspect(setting.key)
      if (!isRegistered(inspection) || isSettingEqual(inspection?.globalValue, setting.value)) continue
      const decision = guard.check(setting.key, now())
      if (decision === 'suspended') continue
      if (decision === 'suspended-now') {
        logger.error(`${setting.key}: restored too often - something else keeps changing it, left alone this session`)
        continue
      }
      const result = await applySetting({ logger, setting, store })
      if (result.state !== 'applied' || reported) continue
      reported = true
      onFirstRestore(setting.key)
    }
  }
}
