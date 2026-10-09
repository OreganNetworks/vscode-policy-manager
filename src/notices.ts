/*
 * Notifications that survive an extension host restart.  Turning the built-in AI off while Copilot Chat runs makes
 * VS Code stop Copilot Chat, which it does by restarting the extension host the moment the setting is written - before
 * a notification from the old host reaches the window.  So a notice is saved before the write, shown once the write is
 * done, and shown by the next session when the old one never got the chance.
 */
import { describeError, type Logger } from './logger'
import { MANAGED_SETTINGS, type ManagedSetting } from './policy/settings'

/** A saved notice older than this is dropped: the restart it waited for has long happened */
const MAX_AGE_MS = 2 * 60 * 1000 // a restart takes seconds; activation after it, up to half a minute

/** A notification the extension shows, by kind, so a later session can show it again */
export type Notice = { kind: 'ai-switched-off' } | { key: string; kind: 'setting-restored' }

/** The notice that the built-in AI and GitHub Copilot are switched off */
export const AI_SWITCHED_OFF: Notice = { kind: 'ai-switched-off' }

/** A notice saved before the write it reports, with when it was saved */
export type SavedNotice = {
  /** Epoch milliseconds */
  at: number
  notice: Notice
}

/** Port over `ExtensionContext.workspaceState`, which is per window and survives an extension host restart */
export type NoticeStore = {
  get(): readonly SavedNotice[] | undefined
  set(value: readonly SavedNotice[]): Promise<void>
}

/** Arguments to {@link createNotices} */
export type NoticesOptions = {
  logger: Logger
  /** Shows the notification, and settles once the developer closes it or picks a button */
  show: (notice: Notice) => Promise<void>
  store: NoticeStore
  now?: () => number
}

/** See {@link createNotices} */
export type Notices = {
  /** Saves `notice`.  Await it before the write it reports, which may restart the extension host. */
  save(notice: Notice): Promise<void>
  /** Shows a saved notice once its write is done, and forgets it when the notification is closed */
  show(notice: Notice): void
  /** Forgets a saved notice whose write did not happen */
  forget(notice: Notice): Promise<void>
  /** On start-up: shows the notices a previous session saved in the last two minutes, and drops older ones */
  showSaved(): void
}

/**
 * Notices saved in `store` around the writes they report.  A notice stays saved until its notification is closed, so
 * one that a restart cut short is shown again by the next session.  Never throws: a storage failure is logged, and
 * costs at most a lost or repeated notification.
 */
export function createNotices({ logger, now = Date.now, show, store }: NoticesOptions): Notices {
  const same = (a: Notice, b: Notice) => JSON.stringify(a) === JSON.stringify(b)
  const saved = () => store.get() ?? []

  async function write(value: readonly SavedNotice[]): Promise<void> {
    try {
      await store.set(value)
    } catch (error: unknown) {
      logger.warn(`Notices: could not save - ${describeError(error)} (ignored)`)
    }
  }

  async function forget(notice: Notice): Promise<void> {
    await write(saved().filter(entry => !same(entry.notice, notice)))
  }

  function display(notice: Notice): void {
    show(notice).then(
      () => forget(notice),
      (error: unknown) => logger.warn(`Notices: could not show a notification - ${describeError(error)} (ignored)`),
    )
  }

  return {
    async save(notice) {
      await write([...saved().filter(entry => !same(entry.notice, notice)), { at: now(), notice }])
    },
    show: display,
    forget,
    showSaved() {
      const fresh = saved().filter(entry => now() - entry.at <= MAX_AGE_MS)
      if (fresh.length !== saved().length) void write(fresh)
      for (const { notice } of fresh) display(notice)
    },
  }
}

/**
 * The notice for a managed setting put back to its policy value.  An AI setting gets the notice that the built-in AI
 * is switched off, which is what the developer just tried to undo; any other setting is named.
 *
 * @param key       The setting written.
 * @param settings  Defaults to {@link MANAGED_SETTINGS}.
 * @returns The notice to save and show.
 *
 * @example
 * noticeForRestore('chat.disableAIFeatures')   // { kind: 'ai-switched-off' }
 * noticeForRestore('telemetry.telemetryLevel') // { key: 'telemetry.telemetryLevel', kind: 'setting-restored' }
 */
export function noticeForRestore(key: string, settings: readonly ManagedSetting[] = MANAGED_SETTINGS): Notice {
  const group = settings.find(setting => setting.key === key)?.group
  return group === 'ai' ? AI_SWITCHED_OFF : { key, kind: 'setting-restored' }
}
