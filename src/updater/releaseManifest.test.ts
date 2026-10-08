import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { sha256 } from './download'
import { parseManifest } from './manifest'
import { createTempDirs } from '../testing/tempDirs'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = join(ROOT, 'scripts', 'write-manifest.mjs')
const CONTENT = 'not really a vsix'
const temp = createTempDirs('opm-release-')
after(temp.removeAll)

async function packageInfo(): Promise<{ name: string; version: string }> {
  return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string }
}

describe('scripts/write-manifest.mjs', () => {
  it('writes a manifest the updater accepts', async () => {
    const { name, version } = await packageInfo()
    const dir = await temp.make()
    const vsix = `${name}-${version}.vsix`
    await writeFile(join(dir, vsix), CONTENT)
    execFileSync(process.execPath, [SCRIPT, join(dir, vsix), join(dir, 'manifest.json')], { stdio: 'pipe' })
    assert.deepEqual(parseManifest(await readFile(join(dir, 'manifest.json'), 'utf8')), {
      sha256: sha256(Buffer.from(CONTENT)),
      version,
      vsix,
    })
  })

  it('refuses a VSIX whose name does not match package.json', async () => {
    const dir = await temp.make()
    await writeFile(join(dir, 'other-9.9.9.vsix'), CONTENT)
    assert.throws(() =>
      execFileSync(process.execPath, [SCRIPT, join(dir, 'other-9.9.9.vsix'), join(dir, 'manifest.json')], {
        stdio: 'pipe',
      }),
    )
  })
})
