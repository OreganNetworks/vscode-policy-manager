import { type SettingInspection, type SettingsStore, type SettingValue } from '../policy/settings'

/** A settings store for specs: every entry, plus the keys written, in order */
export type FakeStore = SettingsStore & { entries: Record<string, SettingInspection>; writes: string[] }

/**
 * A store over plain objects.  A key missing from `entries` behaves like one no installed component registered.  An
 * entry without an `effectiveValue` gets the one the editor would work out from its workspace, user and default values.
 */
export function createFakeStore(
  entries: Record<string, SettingInspection>,
  failKeys: readonly string[] = [],
): FakeStore {
  const writes: string[] = []
  return {
    entries,
    inspect(key) {
      const entry = entries[key]
      if (!entry) return undefined
      return { effectiveValue: entry.workspaceValue ?? entry.globalValue ?? entry.defaultValue, ...entry }
    },
    async updateGlobal(key: string, value: SettingValue) {
      if (failKeys.includes(key)) throw new Error(`Unable to write ${key} because it is configured in system policy.`)
      writes.push(key)
      entries[key] = { ...entries[key], globalValue: value }
    },
    writes,
  }
}

/** Every managed key registered with its editor default and no user value */
export function stockEntries(): Record<string, SettingInspection> {
  return {
    'chat.disableAIFeatures': { defaultValue: false },
    'github.copilot.enable': { defaultValue: { '*': true, markdown: false } },
    'redhat.telemetry.enabled': { defaultValue: null },
    'telemetry.telemetryLevel': { defaultValue: 'all' },
  }
}
