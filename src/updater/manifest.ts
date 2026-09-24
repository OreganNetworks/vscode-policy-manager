/** `manifest.json`, published next to the VSIX on every GitHub Release */
export type ReleaseManifest = {
  /** Lower-case hex SHA-256 of the VSIX */
  sha256: string
  version: string
  /** Bare file name of the VSIX asset */
  vsix: string
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
// A bare file name - it is joined onto the release URL and onto a local path, so no separators and no `..`
const VSIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.vsix$/

/** Parse and validate `manifest.json`.  Throws an `Error` that names the first problem. */
export function parseManifest(text: string): ReleaseManifest {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('manifest.json is not valid JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error('manifest.json is not an object')
  const { sha256, version, vsix } = data as Record<string, unknown>
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version))
    throw new Error(`manifest.json version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`)
  if (typeof vsix !== 'string' || !VSIX_PATTERN.test(vsix) || vsix.includes('..'))
    throw new Error(`manifest.json vsix ${JSON.stringify(vsix)} is not a bare .vsix file name`)
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256.toLowerCase()))
    throw new Error('manifest.json sha256 is not a 64-character hex digest')
  return { sha256: sha256.toLowerCase(), version, vsix }
}

/** Compare two `MAJOR.MINOR.PATCH` versions numerically: negative when `a` is older, `0` when equal */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let part = 0; part < 3; part++) if (left[part] !== right[part]) return left[part] - right[part]
  return 0
}

function parseVersion(version: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(version)
  if (!match) throw new Error(`${version} is not MAJOR.MINOR.PATCH`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
