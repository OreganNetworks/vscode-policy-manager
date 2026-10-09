import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { aiFirstHostMessage, detectHost } from './host'

describe('detectHost', () => {
  it('detects VS Code', () => {
    assert.deepEqual(detectHost('Visual Studio Code'), {
      aiFirst: false,
      cli: 'code',
      extensionSource: 'Microsoft Marketplace',
      kind: 'vscode',
      name: 'VS Code',
    })
  })

  it('detects VS Code Insiders ahead of VS Code, whose name it contains', () => {
    assert.equal(detectHost('Visual Studio Code - Insiders').cli, 'code-insiders')
  })

  it('detects VSCodium', () => {
    assert.deepEqual(detectHost('VSCodium'), {
      aiFirst: false,
      cli: 'codium',
      extensionSource: 'Open VSX',
      kind: 'vscodium',
      name: 'VSCodium',
    })
  })

  it('detects Cursor and Windsurf as AI-first editors', () => {
    assert.deepEqual(detectHost('Cursor'), {
      aiFirst: true,
      cli: 'cursor',
      extensionSource: 'Open VSX',
      kind: 'cursor',
      name: 'Cursor',
    })
    assert.deepEqual(detectHost('Windsurf'), {
      aiFirst: true,
      cli: 'windsurf',
      extensionSource: 'Open VSX',
      kind: 'windsurf',
      name: 'Windsurf',
    })
  })

  it('falls back to the code CLI for an editor it does not know', () => {
    assert.deepEqual(detectHost('Code - OSS'), {
      aiFirst: false,
      cli: 'code',
      extensionSource: 'unknown',
      kind: 'unknown',
      name: 'Code - OSS',
    })
    assert.equal(detectHost('').name, 'unknown editor')
  })
})

describe('aiFirstHostMessage', () => {
  it('gives the AI-first editor message for Cursor and Windsurf', () => {
    assert.deepEqual(aiFirstHostMessage(detectHost('Cursor')), [
      "You're using Cursor. Its built-in AI features aren't on Oregan's approved",
      "AI tool register. Oregan's approved setup is VS Code or VSCodium with Claude Code.",
      "To use Cursor's built-in AI, request approval from your team CSO.",
    ])
    assert.equal(
      aiFirstHostMessage(detectHost('Windsurf'))[0],
      "You're using Windsurf. Its built-in AI features aren't on Oregan's approved",
    )
  })

  it('says nothing for other editors', () => {
    assert.deepEqual(aiFirstHostMessage(detectHost('Visual Studio Code')), [])
    assert.deepEqual(aiFirstHostMessage(detectHost('VSCodium')), [])
  })
})
