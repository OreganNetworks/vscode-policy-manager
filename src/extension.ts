import * as vscode from 'vscode'
import { detectHost } from './host'

const OUTPUT_CHANNEL_NAME = 'Oregan Policy Manager'

/** Entry point.  Only this module imports `vscode` - the policy modules take ports so they run under node:test. */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true })
  context.subscriptions.push(log)
  const host = detectHost(vscode.env.appName)
  log.info(`Oregan Policy Manager ${String(context.extension.packageJSON.version)} on ${host.name} ${vscode.version}`)
}

/** Everything is disposed through `context.subscriptions` */
export function deactivate(): void {}
