// Writes manifest.json for a packaged VSIX, for the extension's self-update.
// Run by .github/workflows/release.yml; runnable locally.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const [vsixPath, outPath = 'manifest.json'] = process.argv.slice(2)
if (!vsixPath) {
  console.error('usage: node scripts/write-manifest.mjs <vsix> [manifest.json]')
  process.exit(1)
}

const { name, version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const vsix = basename(vsixPath)
if (vsix !== `${name}-${version}.vsix`) {
  console.error(`${vsix} does not match package.json (${name}-${version}.vsix)`)
  process.exit(1)
}

const sha256 = createHash('sha256')
  .update(await readFile(vsixPath))
  .digest('hex')
await writeFile(outPath, `${JSON.stringify({ version, vsix, sha256 }, null, 2)}\n`)
console.log(`${outPath}: ${vsix} ${sha256}`)
