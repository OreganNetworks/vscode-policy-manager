import * as vscode from 'vscode'
import { EXTENSION_ID, extensionsDir, readDefaultEntry, waitFor } from './manifest'

/** In the named profile it was installed into, the release install applies itself to all profiles */
export async function run(): Promise<void> {
  await waitFor(() => vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true, 'activation in the profile')
  // 1.90 can ignore the first command, and the extension tries again after 5 and then 30 seconds
  await waitFor(
    () => readDefaultEntry(extensionsDir())?.isApplicationScoped === true,
    'the extension to be applied to all profiles',
    60_000,
  )
}
