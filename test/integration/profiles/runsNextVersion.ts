import * as vscode from 'vscode'
import { EXTENSION_ID, waitFor } from './manifest'

/** After an update from a window with the named profile, a window with either profile runs the new version */
export async function run(): Promise<void> {
  const next = process.env.OPM_TEST_NEXT_VERSION
  await waitFor(() => {
    const ours = vscode.extensions.getExtension(EXTENSION_ID)
    return ours?.isActive === true && ours.packageJSON.version === next
  }, `version ${next} to run`)
}
