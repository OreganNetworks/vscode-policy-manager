/*
 * REQUIREMENT: Claude Code recommendation
 *
 * Points developers at Claude Code, the approved assistant, through the output channel.  Nothing is ever installed
 * automatically.
 */
import { POLICY_URL } from '../links'

/** Claude Code's extension ID, on both the Microsoft Marketplace and Open VSX */
export const CLAUDE_CODE_ID = 'anthropic.claude-code'

/** Arguments to {@link claudeCodeMessage} */
export type ClaudeCodeMessageOptions = {
  /** Host editor CLI from `detectHost()` */
  cli: string
  installed: boolean
}

/**
 * Output channel text.  VS Code has no user-level "recommended extensions", so the recommendation is a message,
 * and nothing is ever installed automatically.
 */
export function claudeCodeMessage({ cli, installed }: ClaudeCodeMessageOptions): string[] {
  if (installed) return [`Claude Code (${CLAUDE_CODE_ID}) is installed - Oregan's approved AI coding assistant.`]
  return [
    "Claude Code is Oregan's approved AI coding assistant (Claude for Teams).",
    'Install it from the Extensions view (search "Claude Code"), or run:',
    `    ${cli} --install-extension ${CLAUDE_CODE_ID}`,
    'Sign in with your Oregan Claude for Teams account.',
    `Policy: ${POLICY_URL}`,
  ]
}
