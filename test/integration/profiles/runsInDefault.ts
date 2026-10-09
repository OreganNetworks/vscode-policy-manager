import * as vscode from 'vscode'
import { EXTENSION_ID, waitFor } from './manifest'

/** A window with the Default profile, which the CLI never installed into, now runs the extension too */
export async function run(): Promise<void> {
  await waitFor(() => vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true, 'activation in Default')
}
