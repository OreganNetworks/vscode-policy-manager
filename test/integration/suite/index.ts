import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import Mocha from 'mocha'

/** Entry point `@vscode/test-electron` calls inside the extension host */
export function run(): Promise<void> {
  const mocha = new Mocha({ color: true, timeout: 60_000, ui: 'bdd' })
  for (const file of readdirSync(__dirname)) if (file.endsWith('.test.js')) mocha.addFile(join(__dirname, file))
  return new Promise((resolve, reject) => {
    mocha.run(failures => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()))
  })
}
