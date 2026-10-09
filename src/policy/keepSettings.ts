/*
 * REQUIREMENT: Keeping settings in place
 *
 * Puts a managed user setting back when something changes it away from the policy value, and writes a key that an
 * extension installed after start-up registers.  Workspace and folder values are never written - the status report
 * shows an override instead.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describeError, type Logger } from '../logger'
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
 * left alone for `suspendMs`: something keeps rewriting it, and a restore loop would thrash `settings.json` without
 * ever winning - and for an AI setting, restart the extension host with every restore.
 */
export type BurstGuard = {
  /**
   * Counts a restore of `key`, once it has been saved, unless the key is suspended.
   *
   * @param key  The setting about to be restored.
   * @param now  Epoch milliseconds.
   * @returns `suspended-now` once, when the key is suspended, so the caller can log it once.
   */
  check(key: string, now: number): Promise<BurstDecision>
}

/** The restores a {@link BurstGuard} counts, and the keys it has suspended, by key, in epoch milliseconds */
export type BurstState = {
  restores: Record<string, number[]>
  suspendedUntil: Record<string, number>
}

/**
 * Where a {@link BurstGuard} keeps its count.  The real one, {@link createFileBurstStore}, is a file the windows share,
 * which outlives the extension host that a restore of an AI setting restarts.
 */
export type BurstStore = {
  get(): Promise<BurstState | undefined>
  set(state: BurstState): Promise<void>
}

/** Arguments to {@link createFileBurstStore} */
export type FileBurstStoreOptions = {
  logger: Logger
  /** The file, under the extension's `globalStorageUri` - shared by every window */
  path: string
}

/** Arguments to {@link createBurstGuard} */
export type BurstGuardOptions = {
  limit: number
  /** How long a suspended key is left alone */
  suspendMs: number
  windowMs: number
  /** Defaults to one in memory, which an extension host restart forgets */
  store?: BurstStore
}

/*
 * A minute, not seconds: each restore holds the settings lock for 2 s (settingsLock.ts), and one of an AI setting
 * restarts the extension host, so restores come seconds apart however hard something fights.
 */
export const DRIFT_BURST: BurstGuardOptions = { limit: 5, suspendMs: 60 * 60_000, windowMs: 60_000 }

/** A {@link BurstStore} in memory */
export function createMemoryBurstStore(): BurstStore {
  let state: BurstState | undefined
  return {
    async get() {
      return state
    },
    async set(value) {
      state = value
    },
  }
}

/**
 * A {@link BurstStore} in a file the windows share.  It is read and written only by passes that hold the settings lock
 * (`settingsLock.ts`), so each window reads the count the last one left.  `ExtensionContext.globalState` can't do
 * this: another window sees a change to it seconds later, and a window that writes back its own stale copy wipes out
 * a suspension the other window has just made.
 *
 * A missing or unreadable file reads as no restores.  A failed write is logged, and costs at most a restore the guard
 * doesn't count.
 *
 * @param options  The file, and where to log a failure.
 * @returns The store.
 */
export function createFileBurstStore({ logger, path }: FileBurstStoreOptions): BurstStore {
  return {
    async get() {
      try {
        const state: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (isBurstState(state)) return state
        logger.warn(`Drift guard: ${path} holds no restore count, so the count starts again (ignored)`)
      } catch (error: unknown) {
        if (!hasCode(error, 'ENOENT'))
          logger.warn(`Drift guard: could not read ${path} - ${describeError(error)} (ignored)`)
      }
      return undefined
    },
    async set(state) {
      // Written aside and renamed into place, so an extension host stopped part way leaves the last whole count
      const next = `${path}.${process.pid}.tmp`
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(next, JSON.stringify(state))
        await rename(next, path)
      } catch (error: unknown) {
        logger.warn(`Drift guard: could not save the restore count - ${describeError(error)} (ignored)`)
      }
    },
  }
}

function isBurstState(value: unknown): value is BurstState {
  if (typeof value !== 'object' || value === null) return false
  const { restores, suspendedUntil } = value as Partial<Record<keyof BurstState, unknown>>
  return (
    isRecordOf(restores, times => Array.isArray(times) && times.every(isNumber)) && isRecordOf(suspendedUntil, isNumber)
  )
}

function isRecordOf(value: unknown, isEntry: (entry: unknown) => boolean): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isEntry)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

/**
 * Build a {@link BurstGuard}.
 *
 * @param options  The limit, the window and how long a key stays suspended, and where the count is kept.
 * @returns The guard.
 *
 * @example
 * const guard = createBurstGuard({ limit: 2, suspendMs: 60_000, windowMs: 1_000 })
 * await guard.check('a', 0) // 'allowed'
 * await guard.check('a', 100) // 'allowed'
 * await guard.check('a', 200) // 'suspended-now', until 60200
 */
export function createBurstGuard({
  limit,
  store = createMemoryBurstStore(),
  suspendMs,
  windowMs,
}: BurstGuardOptions): BurstGuard {
  return {
    async check(key, now) {
      const state = (await store.get()) ?? { restores: {}, suspendedUntil: {} }
      const until = state.suspendedUntil[key]
      if (until !== undefined && now < until) return 'suspended'
      const recent = (state.restores[key] ?? []).filter(at => now - at < windowMs)
      const restores = { ...state.restores }
      const suspendedUntil = { ...state.suspendedUntil }
      if (recent.length >= limit) {
        delete restores[key]
        suspendedUntil[key] = now + suspendMs
        await store.set({ restores, suspendedUntil })
        return 'suspended-now'
      }
      // An expired suspension is dropped, and the restore is counted before it is made
      delete suspendedUntil[key]
      restores[key] = [...recent, now]
      await store.set({ restores, suspendedUntil })
      return 'allowed'
    },
  }
}

/** Handler for `workspace.onDidChangeConfiguration`, given the event's `affectsConfiguration` */
export type DriftHandler = (affects: (key: string) => boolean) => Promise<void>

/** Arguments to {@link createDriftHandler} */
export type DriftHandlerOptions = {
  /** After the first restore of the session; `restored` is false when the editor refused the write */
  afterFirstRestore: (key: string, restored: boolean) => void
  /**
   * Awaited before the first restore of the session - the policy allows one message per session.  Turning the
   * built-in AI off can restart the extension host as soon as the setting is written, so the message is saved here.
   */
  beforeFirstRestore: (key: string) => Promise<void>
  logger: Logger
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
  afterFirstRestore,
  beforeFirstRestore,
  guard = createBurstGuard(DRIFT_BURST),
  logger,
  now = Date.now,
  settings = MANAGED_SETTINGS,
  store,
}: DriftHandlerOptions): DriftHandler {
  let reported = false
  return async function onConfigurationChanged(affects) {
    for (const setting of settings) {
      if (!affects(setting.key)) continue
      const inspection = store.inspect(setting.key)
      if (!isRegistered(inspection) || isSettingEqual(inspection?.globalValue, setting.value)) continue
      const decision = await guard.check(setting.key, now())
      if (decision === 'suspended') continue
      if (decision === 'suspended-now') {
        logger.error(`${setting.key}: restored too often - something else keeps changing it, left alone for an hour`)
        continue
      }
      const first = !reported
      if (first) await beforeFirstRestore(setting.key)
      const result = await applySetting({ logger, setting, store })
      if (!first) continue
      reported = result.state === 'applied'
      afterFirstRestore(setting.key, reported)
    }
  }
}
