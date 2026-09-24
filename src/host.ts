/*
 * REQUIREMENT: Multi-editor support
 *
 * One VSIX serves VS Code, VSCodium, Cursor and Windsurf.  This module identifies the editor, names its CLI, and words
 * the message for an AI-first editor whose own assistant the extension API can't reach.
 */
/**
 * Editors the extension can name.  `unknown` covers any other VS Code derivative - the policy is still applied in
 * full, the output channel just can't name its CLI.
 */
export type EditorKind = 'cursor' | 'unknown' | 'vscode' | 'vscode-insiders' | 'vscodium' | 'windsurf'

/**
 * What the extension needs to know about the editor it is running in.  Detected from
 * `vscode.env.appName`, since a single VSIX serves every editor.
 */
export type HostInfo = {
  /** True for editors whose own assistant is configured outside the extension API (Cursor Tab, Windsurf Cascade) */
  aiFirst: boolean
  /** CLI used in install instructions, e.g. `codium --install-extension ...` */
  cli: string
  /** Where the editor installs extensions from */
  extensionSource: 'Microsoft Marketplace' | 'Open VSX' | 'unknown'
  kind: EditorKind
  /** Human-readable editor name */
  name: string
}

type HostRule = {
  /** Substring of `vscode.env.appName` */
  match: string
  info: HostInfo
}

// Insiders comes first - its appName also contains `Visual Studio Code`
const HOST_RULES: readonly HostRule[] = [
  {
    match: 'Visual Studio Code - Insiders',
    info: {
      aiFirst: false,
      cli: 'code-insiders',
      extensionSource: 'Microsoft Marketplace',
      kind: 'vscode-insiders',
      name: 'VS Code Insiders',
    },
  },
  {
    match: 'Visual Studio Code',
    info: { aiFirst: false, cli: 'code', extensionSource: 'Microsoft Marketplace', kind: 'vscode', name: 'VS Code' },
  },
  {
    match: 'VSCodium',
    info: { aiFirst: false, cli: 'codium', extensionSource: 'Open VSX', kind: 'vscodium', name: 'VSCodium' },
  },
  {
    match: 'Cursor',
    info: { aiFirst: true, cli: 'cursor', extensionSource: 'Open VSX', kind: 'cursor', name: 'Cursor' },
  },
  {
    match: 'Windsurf',
    info: { aiFirst: true, cli: 'windsurf', extensionSource: 'Open VSX', kind: 'windsurf', name: 'Windsurf' },
  },
]

/** Identify the host editor from `vscode.env.appName` */
export function detectHost(appName: string): HostInfo {
  const rule = HOST_RULES.find(candidate => appName.includes(candidate.match))
  if (rule) return rule.info
  return { aiFirst: false, cli: 'code', extensionSource: 'unknown', kind: 'unknown', name: appName || 'unknown editor' }
}

/** Output channel text for an AI-first editor, whose own assistant the extension API can't reach */
export function aiFirstHostMessage(host: HostInfo): string[] {
  if (!host.aiFirst) return []
  return [
    `You're using ${host.name}. Its built-in AI features aren't on Oregan's approved`,
    "AI tool register. Oregan's approved setup is VS Code or VSCodium with Claude Code.",
    `To use ${host.name}'s built-in AI, request approval from your team CSO.`,
  ]
}
