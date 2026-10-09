import { type Logger } from '../logger'

/** A logger that records `"<level>: <message>"` lines for specs to assert on */
export type FakeLogger = Logger & { lines: string[] }

/** Shared by every spec that takes a `Logger` */
export function createFakeLogger(): FakeLogger {
  const lines: string[] = []
  const record = (level: string) =>
    function log(message: string) {
      lines.push(`${level}: ${message}`)
    }
  return { debug: record('debug'), error: record('error'), info: record('info'), lines, warn: record('warn') }
}
