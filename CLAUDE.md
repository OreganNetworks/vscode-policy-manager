# Claude Context: Oregan Policy Manager

## What this project is

Oregan Policy Manager is an editor extension that applies Oregan's AI and
telemetry policy at user level, once per machine: telemetry off, built-in AI
and GitHub Copilot off, Copilot extensions removed, Claude Code recommended. It
self-updates from GitHub Releases. See `README.md` for the user-facing
description.

- **Extension ID:** `oregan.oregan-policy-manager` (`publisher: "oregan"`,
  `name: "oregan-policy-manager"`)
- **First version:** `0.1.0`
- **Repo:** `OreganNetworks/vscode-policy-manager` - also the release repo, so
  the updater URLs are built from this name
- **Ticket:** [TMP-7075](https://oregannetworks.atlassian.net/browse/TMP-7075),
  under the [ONYX-6573](https://oregannetworks.atlassian.net/browse/ONYX-6573)
  Claude Integration epic

## Source of truth

The design is not in this repo. It lives in two attachments on TMP-7075:

- `oregan-vscode-extension-spec.md` - Draft v0.4, functional requirements
  FR-1 to FR-8, manifest essentials and code layout
- `oregan-vscode-extension-plan.md` - delivery plan, Phases 0 to 7

Read both before implementing anything. Fetch them through the Atlassian MCP:
`getJiraIssue` with `fields: ["attachment"]` for the attachment ids, then
`downloadJiraIssueAttachment` for each one. If the implementation has to
diverge from the spec, raise it rather than quietly deviating - the spec is
what the CSO signs off.

## Status

Docs only. Nothing is scaffolded yet. Phase 1 starts with:

```sh
npx --package yo --package generator-code -- yo code
```

(TypeScript), then trims the generated `package.json` to the manifest in spec
section 5.

## Planned layout

```
src/
  extension.ts    # activate/deactivate, wiring
  host.ts         # editor detection, CLI name (FR-6)
  policy.ts       # managed settings table, apply/watch (FR-1, FR-2, FR-4)
  copilot.ts      # detection and ordered removal (FR-3)
  recommend.ts    # Claude Code check and output message (FR-5)
  updater.ts      # manifest, download, hash, install, timer, lock (FR-7)
  status.ts       # status report (FR-8)
test/
.github/workflows/release.yml
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
   (`https`, `crypto`, `fs`). Dev dependencies are fine.
9. **No data collection.** The only outbound requests are GETs for
   `manifest.json` and the VSIX.
10. **Updater behaviour** (FR-7):
    - fetch `releases/latest/download/manifest.json` unauthenticated - a plain
      download URL is not subject to the REST API's 60 requests/hour limit,
      which matters with many developers behind one office IP
    - verify the SHA-256 before `workbench.extensions.installExtension`
    - one window per cycle, via a short-lived lock file in `globalStorageUri`
    - every 60 minutes plus up to 5 minutes of jitter, cleared in `deactivate()`
    - on any failure, log and wait for the next cycle - the running version is
      never disturbed
11. **Quiet by default.** Detail goes to the output channel. Notifications only
    when something changes, and the drift message at most once per session.
12. **Cheap activation.** `onStartupFinished`, under 50 ms of work before
    yielding, all network calls async.

## Open questions

From spec section 8. These gate design decisions, so check whether they have
been answered before building on an assumption:

1. CSO sign-off for company-wide distribution, and for making the release repo
   public. If it has to stay private, FR-7 switches to authenticated requests
   via `vscode.authentication.getSession('github', ['repo'])`.
2. Is Claude Code on Open VSX, so the FR-5 instruction works in VSCodium,
   Cursor and Windsurf?
3. Each fork's VS Code base version, the resulting `engines.vscode` floor, and
   whether each fork registers `chat.disableAIFeatures`.
4. Are Cursor and Windsurf in use, and will the CSO approve their built-in AI
   or steer those developers to VS Code or VSCodium?

## Repo conventions

1. **British English** in docs, comments and user-facing strings
   (`behaviour`, `organisation`, `licence` as the noun).
2. **Docs track features.** Any change to behaviour, the managed settings or
   extension lists, or the commands updates `README.md` in the same commit.
3. **Commit messages.** `TMP-7075: summary` while the work is under that
   ticket, otherwise `area: summary`. Specific over generic.
4. **Never push without being asked.** Commits stay local until explicitly told
   to push, and each push needs its own go-ahead.
