import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CLAUDE_CODE_ID, claudeCodeMessage } from './recommendClaudeCode'

describe('claudeCodeMessage', () => {
  it('gives the install instructions, with the host CLI, when Claude Code is missing', () => {
    assert.deepEqual(claudeCodeMessage({ cli: 'codium', installed: false }), [
      "Claude Code is Oregan's approved AI coding assistant (Claude for Teams).",
      'Install it from the Extensions view (search "Claude Code"), or run:',
      '    codium --install-extension anthropic.claude-code',
      'Sign in with your Oregan Claude for Teams account.',
      'Policy: https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/3808264194',
    ])
  })

  it('logs a single confirmation line when Claude Code is installed', () => {
    assert.deepEqual(claudeCodeMessage({ cli: 'code', installed: true }), [
      `Claude Code (${CLAUDE_CODE_ID}) is installed - Oregan's approved AI coding assistant.`,
    ])
  })
})
