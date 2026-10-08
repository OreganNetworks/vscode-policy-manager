import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const EXTENSION_ID = 'oregannetworks.oregan-policy-manager'
/** The named profile the suite installs into; the editor creates it the first time a window opens with it */
export const PROFILE = 'Work'

/** Our entry in the `extensions.json` of the default profile, in the extensions folder - `undefined` when not listed */
export function readDefaultEntry(extensionsDir: string): { isApplicationScoped: boolean; version: string } | undefined {
  let entries: { identifier: { id: string }; metadata?: { isApplicationScoped?: boolean }; version: string }[]
  try {
    entries = JSON.parse(readFileSync(join(extensionsDir, 'extensions.json'), 'utf8'))
  } catch {
    return undefined
  }
  const entry = entries.find(record => record.identifier.id.toLowerCase() === EXTENSION_ID)
  return entry && { isApplicationScoped: entry.metadata?.isApplicationScoped === true, version: entry.version }
}

/** `OPM_TEST_EXTENSIONS_DIR`, which `runTests.ts` sets */
export function extensionsDir(): string {
  const dir = process.env.OPM_TEST_EXTENSIONS_DIR
  if (!dir) throw new Error('OPM_TEST_EXTENSIONS_DIR is not set')
  return dir
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
