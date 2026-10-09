import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = resolve(__dirname, '..')

/** The `package.json` fields the global constraints fix */
type PackageJson = {
  activationEvents?: unknown
  capabilities?: { untrustedWorkspaces?: unknown }
  dependencies?: Record<string, string>
  engines?: { vscode?: unknown }
  extensionKind?: unknown
  icon?: unknown
  name?: unknown
  publisher?: unknown
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('package.json', () => {
  it('keeps the extension ID oregannetworks.oregan-policy-manager', () => {
    assert.equal(manifest.publisher, 'oregannetworks')
    assert.equal(manifest.name, 'oregan-policy-manager')
  })

  it('activates after start-up, on the local side, from VS Code 1.90', () => {
    assert.deepEqual(manifest.activationEvents, ['onStartupFinished'])
    assert.deepEqual(manifest.extensionKind, ['ui'])
    assert.equal(manifest.engines?.vscode, '^1.90.0')
  })

  it('has a PNG icon of at least 128 by 128 pixels - vsce refuses an SVG one', () => {
    assert.equal(typeof manifest.icon, 'string')
    const png = readFileSync(join(ROOT, manifest.icon as string))
    assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'not a PNG')
    // The IHDR chunk comes first, with the width and height after its length and type
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)]
    assert.equal(width, height)
    assert.ok(width >= 128, `${width} pixels wide`)
  })

  it('has no runtime dependencies', () => {
    assert.deepEqual(manifest.dependencies ?? {}, {})
  })

  it('runs in Restricted Mode windows - it never reads or runs workspace content', () => {
    assert.deepEqual(manifest.capabilities?.untrustedWorkspaces, { supported: true })
  })
})
