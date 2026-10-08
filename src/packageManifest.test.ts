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
  name?: unknown
  publisher?: unknown
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson

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

  it('has no runtime dependencies', () => {
    assert.deepEqual(manifest.dependencies ?? {}, {})
  })

  it('runs in Restricted Mode windows - it never reads or runs workspace content', () => {
    assert.deepEqual(manifest.capabilities?.untrustedWorkspaces, { supported: true })
  })
})
