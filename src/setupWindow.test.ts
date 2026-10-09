import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isSetupWindow, SETUP_FILE_NAME } from './setupWindow'

describe('isSetupWindow', () => {
  it('recognises a window with no folder and the setup file open', () => {
    assert.equal(isSetupWindow({ documents: [`/tmp/${SETUP_FILE_NAME}`], folderCount: 0 }), true)
    assert.equal(
      isSetupWindow({ documents: ['/home/me/notes.txt', `C:\\Temp\\${SETUP_FILE_NAME}`], folderCount: 0 }),
      true,
    )
  })

  it('leaves a window with a folder open alone, setup file or not', () => {
    assert.equal(isSetupWindow({ documents: [`/tmp/${SETUP_FILE_NAME}`], folderCount: 1 }), false)
  })

  it('leaves an empty window, or one with other files, alone', () => {
    assert.equal(isSetupWindow({ documents: [], folderCount: 0 }), false)
    assert.equal(isSetupWindow({ documents: ['/tmp/setup.txt'], folderCount: 0 }), false)
  })
})
