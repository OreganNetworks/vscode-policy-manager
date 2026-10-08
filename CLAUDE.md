# Claude Context: Oregan Policy Manager

## What this project is

Oregan Policy Manager is an editor extension that applies Oregan's AI and
telemetry policy at user level, once per machine: telemetry off, built-in AI
and GitHub Copilot off, Copilot extensions removed, Claude Code recommended. It
self-updates from GitHub Releases. See `README.md` for the user-facing
description.

- **Extension ID:** `oregannetworks.oregan-policy-manager`
  (`publisher: "oregannetworks"`, `name: "oregan-policy-manager"`)
- **First version:** `0.1.0`
- **Repo:** `OreganNetworks/vscode-policy-manager` - also the release repo, so
  the updater URLs are built from this name
- **Ticket:** [TMP-7075](https://oregannetworks.atlassian.net/browse/TMP-7075),
  under the [ONYX-6573](https://oregannetworks.atlassian.net/browse/ONYX-6573)
  Claude Integration epic

## Source of truth

The design is not in this repo. It lives in two attachments on TMP-7075. A
re-upload carries a date prefix (`2026-10-08b_...`), so read the newest of each:

- `oregan-vscode-extension-spec.md` - Draft v0.8: the functional requirements,
  manifest essentials and code layout; section 9 lists the changes since v0.6
- `oregan-vscode-extension-implementation-plan.md` - the task-by-task
  implementation plan, with the work since the first review as Tasks 12 to 21

Read both before implementing anything. Fetch them through the Atlassian MCP:
`getJiraIssue` with `fields: ["attachment"]` for the attachment ids, then
`downloadJiraIssueAttachment` for each one. If the implementation has to
diverge from the spec, raise it rather than quietly deviating - the spec is
what the CSO signs off.

## Status

Implemented, not yet released. The implementation plan that built it is
attached to TMP-7075 as `oregan-vscode-extension-implementation-plan.md`.

## Commands

```sh
pnpm install
pnpm build          # src -> out/
pnpm test           # node:test specs (src/**/*.test.ts), no editor needed
xvfb-run -a pnpm test:integration  # @vscode/test-electron, a real editor (Linux needs xvfb-run -a)
VSCODE_TEST_VERSION=stable xvfb-run -a pnpm test:integration
pnpm typecheck
pnpm lint           # pnpm lint:fix to apply the fixes
pnpm format:check
pnpm check          # build, typecheck, lint, format:check, test - the fast CI gates
pnpm package        # oregan-policy-manager-<version>.vsix
```

Each of these is also a VS Code task (`.vscode/tasks.json`), with status-bar
buttons when the recommended `actboy168.tasks` extension is installed.

F5 in VS Code runs the extension in an isolated profile under `.vscode-test/` -
never point it at your own profile, it will apply the policy there. The **Try
extension (clean editor)** task does the same for the packaged VSIX, in a
throwaway editor under `.vscode-test/try/`; **Add extension** installs it into
a profile of your own editor.

## Layout

```
src/
  extension.ts    # the only module that imports vscode: ports, commands, notifications
  policy/         # what the policy enforces, one requirement per file
    applyToAllProfiles.ts       # every profile
    keepOutOfSync.ts            # out of Settings Sync
    settings.ts                 # telemetry off; built-in AI and Copilot settings off
    keepSettings.ts             # keeping settings in place
    removeCopilotExtensions.ts  # Copilot extension removal
    recommendClaudeCode.ts      # Claude Code recommendation
  host.ts         # multi-editor support: editor detection, CLI name, AI-first message
  status.ts       # policy status report
  updater/        # the self-update, and everything only it uses
    selfUpdate.ts         # update check and timer
    cliInstall.ts         # installing an update with the editor CLI, into the Default profile
    manifest.ts           # release manifest parsing, version comparison
    download.ts           # bounded HTTPS GET, verified download
    lock.ts               # single-window cycle lock
    releaseManifest.test.ts  # release script output against what the updater accepts
  notices.ts      # notifications saved across an extension host restart
  logger.ts       # Logger port, describeError
  links.ts        # policy and IDE Configuration URLs
  testing/        # spec helpers, excluded from the build
test/integration/ # @vscode/test-electron suite; profiles/ runs the packaged VSIX in a named profile
test/fixtures/    # fake managed extensions the suite installs, and the host for the profiles suite
scripts/write-manifest.mjs
scripts/add-extension.mjs      # the Add extension and Try extension tasks
.github/workflows/ci.yml       # every PR: lint, format, typecheck, build, test, package, integration
.github/workflows/release.yml  # v* tags: test, package, publish the VSIX and manifest.json as Latest (stable)
.github/workflows/promote.yml  # Promote to stable: mark an earlier (or later) release Latest, behind reviewers
.github/CODEOWNERS             # ONYX and the admins outside it own every file; every PR needs one's approval
```

## Design constraints

These are the ones that are easy to get wrong:

1. **User settings only.** Write with `ConfigurationTarget.Global`. Never write
   workspace or folder settings - the per-repo `.vscode` approach is what this
   replaces.
2. **Only write registered keys.** `update()` throws for a key no installed
   component has registered, so check `getConfiguration().inspect(key)` first
   and skip (and log) anything unregistered. This is what lets one VSIX run
   across editor versions and forks.
3. **Uninstall order matters.** Dependants
   (`ms-dotnettools.vscode-dotnet-modernize`, `vscjava.vscode-java-upgrade`) go
   before `github.copilot-chat`, which goes before `github.copilot`. Match
   extension IDs case-insensitively.
4. **Never install anything but our own update.** Claude Code is recommended
   through the output channel only.
5. **Leave Claude Code alone.** `chat.disableAIFeatures` does not govern
   `anthropic.claude-code` (it contributes no `chatParticipants` and no
   language-model API). Check any newly managed setting against Claude Code
   before adding it.
6. **Detect, don't assume.** Identify the host with `vscode.env.appName` and
   feature-detect at runtime. `engines.vscode` is deliberately low
   (`^1.90.0`, floor confirmed in Phase 1) so forks on older bases can install.
7. **`extensionKind: ["ui"]`** keeps the extension local in Remote-SSH, WSL and
   Dev Container sessions.
8. **No runtime dependencies** beyond the VS Code API and Node built-ins
   (`https`, `crypto`, `fs`, and `child_process` for the editor CLI that
   installs updates). Dev dependencies are fine.
9. **No data collection.** The only outbound requests are GETs for
   `manifest.json` and the VSIX.
10. **Updater behaviour:**
    - fetch `releases/latest/download/manifest.json` unauthenticated - a plain
      download URL is not subject to the REST API's 60 requests/hour limit,
      which matters with many developers behind one office IP
    - follow the stable release, which is the one GitHub marks Latest: install
      it whenever its version differs from the running one, older included, so
      rolling stable back reaches every copy. Checks are off outside
      `ExtensionMode.Production` (F5, the integration suite)
    - verify the SHA-256, then install with the editor CLI into the Default
      profile (`updater/cliInstall.ts`), not `workbench.extensions.installExtension`:
      from a window with a named profile that writes only that profile's list,
      and every window keeps running the old version
    - one window per cycle, via a short-lived lock file in `globalStorageUri`
    - every 60 minutes plus up to 5 minutes of jitter, cleared in `deactivate()`
    - on any failure, log and wait for the next cycle - the running version is
      never disturbed
11. **Quiet by default.** Detail goes to the output channel. Notifications only
    when something changes, and the drift message at most once per session.
12. **Cheap activation.** `onStartupFinished`, under 50 ms of work before
    yielding, all network calls async.
13. **Built-in Copilot Chat.** VS Code 1.138+ ships `GitHub.copilot-chat` built
    in, and the uninstall command refuses built-ins. The remover skips it and
    `chat.disableAIFeatures` is what switches it off - keep that setting in the
    table.
14. **Every profile.** VS Code can't apply an extension to all profiles from
    the manifest or the CLI, so a release install runs
    `workbench.extensions.action.toggleApplyToAllProfiles` on itself. It is an
    internal command and a toggle: read `isApplicationScoped` from the
    `extensions.json` in the extensions folder first, and never run it when that
    already reads as applied. It can be too early when the extension activates
    (1.139 may not have registered it yet, 1.90 ignores it until its extension
    list is loaded), hence the retries.
15. **Switching the AI off restarts the extension host.** While Copilot Chat
    runs, writing `chat.disableAIFeatures: true` makes VS Code restart the
    extension host in the same moment, so a notification sent after the write
    is lost. Save it with `notices.ts` before the write; the next session shows
    what the old one could not.
16. **Out of Settings Sync.** The managed keys go in
    `settingsSync.ignoredSettings` and the managed extensions (and this one) in
    `settingsSync.ignoredExtensions`, merged with the developer's own entries.
    Otherwise a change made on another machine on the same sync account comes
    back as drift, and restoring an AI setting restarts the extension host.

## Open questions

From spec section 8. These gate design decisions, so check whether they have
been answered before building on an assumption:

1. CSO sign-off for company-wide distribution, and for making the release repo
   public. If it has to stay private, the self-update switches to authenticated
   requests via `vscode.authentication.getSession('github', ['repo'])`.
2. Answered: Claude Code is on Open VSX (`Anthropic.claude-code`), so the
   install instruction works in VSCodium, Cursor and Windsurf.
3. Each fork's VS Code base version, the resulting `engines.vscode` floor, and
   whether each fork registers `chat.disableAIFeatures` and has the command
   that applies the extension to all profiles.
4. Are Cursor and Windsurf in use, and will the CSO approve their built-in AI
   or steer those developers to VS Code or VSCodium?
5. Who owns the accounts that register the `oregannetworks` publisher on the
   VS Code Marketplace and Open VSX (TMP-8141).
6. Who are the required reviewers on the `release` environment that
   **Promote to stable** runs in. The ONYX team, as far as we know. The
   environment exists, limited to `main`, but on the GitHub Team plan required
   reviewers wait for the repository to be public, and the workflow refuses to
   run until it has them. README **Going public** has the steps.
7. Rollout: each developer installs the extension by hand and can uninstall
   it. Will IT push the install, for example with an MDM script?

## Repo conventions

1. **British English** in docs, comments and user-facing strings
   (`behaviour`, `organisation`, `licence` as the noun).
2. **Docs track features.** Any change to behaviour, the managed settings or
   extension lists, or the commands updates `README.md` in the same commit.
3. **Commit messages.** `TMP-7075: summary` while the work is under that
   ticket, otherwise `area: summary`. Specific over generic.
4. **Never push without being asked.** Commits stay local until explicitly told
   to push, and each push needs its own go-ahead.
5. **One requirement per file.** Each requirement lives in its own module -
   under `src/policy/` for what the policy enforces - starting with a
   `REQUIREMENT: <name>` header. Requirements that share one table can share
   its module, with a header line each: `settings.ts` holds telemetry off and
   the built-in AI settings, both rows of `MANAGED_SETTINGS`. Don't cite the
   spec's FR numbers in code or docs: they mean nothing once the spec is
   revised.
