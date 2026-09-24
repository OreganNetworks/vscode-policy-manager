import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareVersions, parseManifest } from './manifest'

const SHA = 'ab'.repeat(32)
const valid = { sha256: SHA, version: '1.2.0', vsix: 'oregan-policy-manager-1.2.0.vsix' }
const text = (value: unknown) => JSON.stringify(value)

describe('parseManifest', () => {
  it('accepts the manifest CI publishes', () => {
    assert.deepEqual(parseManifest(text(valid)), valid)
  })

  it('normalises the digest to lower case', () => {
    assert.equal(parseManifest(text({ ...valid, sha256: SHA.toUpperCase() })).sha256, SHA)
  })

  it('rejects text that is not a JSON object', () => {
    assert.throws(() => parseManifest('<html>'), /not valid JSON/)
    assert.throws(() => parseManifest('[]'), /not an object/)
    assert.throws(() => parseManifest('null'), /not an object/)
  })

  it('rejects a version that is not MAJOR.MINOR.PATCH', () => {
    for (const version of ['1.2', '1.2.0-beta.1', 'v1.2.0', '01.2.0', 12])
      assert.throws(() => parseManifest(text({ ...valid, version })), /version/)
  })

  it('rejects a vsix that is not a bare .vsix file name', () => {
    for (const vsix of ['../evil.vsix', 'dir/x.vsix', 'https://example.com/x.vsix', 'x.zip', '.vsix', 'a..vsix', ''])
      assert.throws(() => parseManifest(text({ ...valid, vsix })), /vsix/)
  })

  it('rejects a digest that is not 64 hex characters', () => {
    for (const sha256 of ['abc', 'zz'.repeat(32), undefined])
      assert.throws(() => parseManifest(text({ ...valid, sha256 })), /sha256/)
  })
})

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
    assert.ok(compareVersions('0.1.0', '0.1.1') < 0)
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
    assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  })

  it('throws on a malformed version', () => {
    assert.throws(() => compareVersions('0.1', '0.1.0'), /MAJOR.MINOR.PATCH/)
  })
})
