/*
 * REQUIREMENT: Copilot extension removal
 *
 * Uninstalls GitHub Copilot and the extensions that depend on it, dependants first, and does it again on a reinstall.
 * An editor's built-in Copilot Chat is left in place - it can't be uninstalled, and `chat.disableAIFeatures` switches
 * it off.
 */
import { describeError, type Logger } from '../logger'

/**
 * Managed extensions, in removal order (from the IDE Configuration page's `unwantedRecommendations`).  The two
 * extensions that depend on `github.copilot-chat` come first, so its own uninstall isn't refused.
 */
export const MANAGED_EXTENSIONS: readonly string[] = [
  'ms-dotnettools.vscode-dotnet-modernize',
  'vscjava.vscode-java-upgrade',
  'github.copilot-workspace',
  'github.copilot-nightly',
  'github.copilot-chat',
  'github.copilot',
]

/** An extension as the remover sees it, built by `extension.ts` from `vscode.extensions.all` */
export type InstalledExtension = {
  /** Shipped with the editor, so it can't be uninstalled - VS Code 1.138 ships `GitHub.copilot-chat` */
  builtIn: boolean
  /** `extensionDependencies` from its manifest */
  dependencies: readonly string[]
  displayName: string
  /** As the editor reports it; case varies (`GitHub.copilot` vs `github.copilot`) */
  id: string
}

/** Port over `vscode.extensions` and the `workbench.extensions.uninstallExtension` command */
export type ExtensionRegistry = {
  list(): readonly InstalledExtension[]
  /** Rejects when the editor refuses, e.g. another installed extension depends on this one */
  uninstall(id: string): Promise<void>
}

/** Arguments to {@link createCopilotRemover} */
export type CopilotRemoverOptions = {
  logger: Logger
  /** One call per pass that removed anything, with the removed extensions' display names */
  notifyRemoved: (displayNames: readonly string[]) => void
  registry: ExtensionRegistry
}

/** Removes managed extensions; see {@link createCopilotRemover} */
export type CopilotRemover = {
  /** Lower-case IDs uninstalled this session that the editor still lists - they keep running until a window reload */
  pendingReload(): readonly string[]
  run(): Promise<void>
}

/** True for an ID on the managed list, compared case-insensitively */
export function isManaged(id: string): boolean {
  return MANAGED_EXTENSIONS.includes(id.toLowerCase())
}

/** The installed managed extensions, in {@link MANAGED_EXTENSIONS} order */
export function planRemoval(installed: readonly InstalledExtension[]): InstalledExtension[] {
  return MANAGED_EXTENSIONS.flatMap(function findInstalled(id) {
    return installed.filter(extension => extension.id.toLowerCase() === id)
  })
}

/** Installed extensions outside the managed list that depend on `id` - they block its uninstall */
export function findUnmanagedDependants(installed: readonly InstalledExtension[], id: string): InstalledExtension[] {
  const target = id.toLowerCase()
  return installed.filter(
    extension =>
      !isManaged(extension.id) && extension.dependencies.some(dependency => dependency.toLowerCase() === target),
  )
}

/**
 * `run()` is called on activation and from `extensions.onDidChange`, which also fires for this remover's own
 * uninstalls.  So runs are single-flight - a call made during a pass schedules exactly one more pass - and each
 * extension is tried once while it stays installed:
 *
 *  - `pending` holds IDs uninstalled this session that the editor still lists (some only go after a window reload)
 *  - `skipped` holds IDs that are built in, or whose uninstall was refused
 *  - `blocked` holds the refused IDs that an extension outside the managed list depended on at the time
 *
 * An ID leaves every set as soon as a pass finds it gone, so a later reinstall is removed again.  A blocked ID is tried
 * again once nothing outside the list depends on it, so removing the blocker removes it in the same session.
 */
export function createCopilotRemover({ logger, notifyRemoved, registry }: CopilotRemoverOptions): CopilotRemover {
  const pending = new Set<string>()
  const skipped = new Set<string>()
  const blocked = new Set<string>()
  let running: Promise<void> | undefined
  let rerun = false

  async function pass(): Promise<void> {
    const installed = registry.list()
    const present = new Set(installed.map(extension => extension.id.toLowerCase()))
    for (const id of [...pending, ...skipped]) {
      if (present.has(id)) continue
      pending.delete(id)
      skipped.delete(id)
      blocked.delete(id)
    }
    for (const id of blocked) {
      if (findUnmanagedDependants(installed, id).length) continue
      blocked.delete(id)
      skipped.delete(id)
    }

    const removed: string[] = []
    for (const extension of planRemoval(installed)) {
      const id = extension.id.toLowerCase()
      if (pending.has(id) || skipped.has(id)) continue
      if (extension.builtIn) {
        skipped.add(id)
        logger.info(
          `${extension.displayName} (${extension.id}) is built in to this editor and can't be uninstalled - ` +
            'chat.disableAIFeatures switches it off instead',
        )
        continue
      }
      try {
        await registry.uninstall(extension.id)
        pending.add(id)
        removed.push(extension.displayName)
        logger.info(`Removed ${extension.displayName} (${extension.id})`)
      } catch (error: unknown) {
        skipped.add(id)
        const blockers = findUnmanagedDependants(installed, id).map(dependant => dependant.id)
        if (blockers.length) blocked.add(id)
        const blockedBy = blockers.length ? ` - ${blockers.join(', ')} depends on it` : ''
        logger.warn(`Could not remove ${extension.id}: ${describeError(error)}${blockedBy}`)
      }
    }
    if (removed.length) notifyRemoved(removed)
  }

  return {
    pendingReload: () => [...pending],
    async run() {
      if (running) {
        rerun = true
        return running
      }
      running = (async function passes() {
        try {
          do {
            rerun = false
            await pass()
          } while (rerun)
        } finally {
          running = undefined
        }
      })()
      return running
    },
  }
}
