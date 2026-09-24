/**
 * The logging surface every module takes.  `vscode.LogOutputChannel` satisfies it, so `extension.ts` passes the
 * output channel straight in, and specs pass `createFakeLogger()`.
 */
export type Logger = {
  debug(message: string): void
  error(message: string): void
  info(message: string): void
  warn(message: string): void
}

/** Message text for a caught value, which may not be an `Error` */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
