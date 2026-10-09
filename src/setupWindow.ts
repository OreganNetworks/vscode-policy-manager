/*
 * The window an install opens only so the extension can apply itself to all profiles.  A fresh install goes into the
 * Default profile, and the extension can only apply itself once it runs, so a developer whose windows all use another
 * profile would never see it.  The install script and the Add extension task open a window with the Default profile on
 * a file named `SETUP_FILE_NAME`; the extension in that window applies itself to all profiles as it does in any window,
 * then closes the window again.
 */

/** The file an install opens the window on, whose text tells the developer what the window is for */
export const SETUP_FILE_NAME = 'oregan-policy-manager-setup.txt'

/** What {@link isSetupWindow} looks at */
export type WindowContents = {
  /** The paths of the open text documents */
  documents: readonly string[]
  /** How many workspace folders the window has */
  folderCount: number
}

/**
 * Whether this window was opened by an install: no workspace folders, and the setup file open.
 *
 * @param contents  The workspace folders and documents of the window.
 * @returns True for the setup window, which can be closed once the extension has applied itself.
 *
 * @example
 * isSetupWindow({ documents: ['/tmp/oregan-policy-manager-setup.txt'], folderCount: 0 }) // true
 * isSetupWindow({ documents: ['/tmp/oregan-policy-manager-setup.txt'], folderCount: 1 }) // false
 */
export function isSetupWindow({ documents, folderCount }: WindowContents): boolean {
  // Either separator, so a Windows path reads the same on every platform
  return folderCount === 0 && documents.some(path => path.split(/[\\/]/).pop() === SETUP_FILE_NAME)
}
