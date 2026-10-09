# Oregan Policy Manager

A VS Code extension that keeps every Oregan developer's editor aligned with our
NDA commitments and the
[Agentic AI Development Policy](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/3808264194/Agentic+AI+Development+Policy)
(POL-SEC-AI-002):

- **Telemetry off**, so no editor usage data leaves the machine.
- **GitHub Copilot off** - Copilot is not on the Section 5 approved register.
- **Claude Code recommended** as the approved assistant (Claude for Teams).

## Contents

- [Install](#install)
- [What it does](#what-it-does)
  - [Commands](#commands)
- [Versions and updates](#versions-and-updates)
- [Supported editors](#supported-editors)
- [Development](#development)
  - [Running it](#running-it)
  - [Releasing](#releasing)
  - [Going public](#going-public)
- [What it is not](#what-it-is-not)
- [References](#references)

## Install

On macOS or Linux:

```sh
curl -fsSL https://github.com/OreganNetworks/vscode-policy-manager/releases/latest/download/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://github.com/OreganNetworks/vscode-policy-manager/releases/latest/download/install.ps1 | iex
```

The script installs the extension into every VS Code, VS Code Insiders,
VSCodium, Cursor and Windsurf it finds:

1. It removes the copies a later install can't replace: one under the old ID
   `oregan.oregan-policy-manager`, and one that a named
   [profile](https://code.visualstudio.com/docs/configure/profiles) has of its
   own, which an update would never reach.
2. It downloads the stable release, checks it against the SHA-256 in its
   `manifest.json`, and installs it into the Default profile.
3. Unless that copy is already applied to all profiles, it opens a window with
   the Default profile on a short setup file. The extension applies itself to
   all profiles there (**Apply Extension to all Profiles**), so that every
   window runs it whatever its profile, then closes the window again. The script
   waits for that, for up to 90 seconds.

Run **Developer: Reload Window** in windows that were already open. Once
installed, the extension is listed under **Installed** in the Extensions view as
**Oregan Policy Manager** (`oregannetworks.oregan-policy-manager`), and it logs
to the **Oregan Policy Manager** channel in the Output panel. It is not on the
Marketplace or Open VSX, so searching there won't find it.

To install a VSIX you have, or into one editor only, run the script from a file:
`sh install.sh --vsix <file> --cli codium` on macOS or Linux, and
`.\install.ps1 -Vsix <file> -Cli codium.cmd` on Windows. For a CLI with another
name, set `OPM_USER_DATA_DIR` and `OPM_EXTENSIONS_DIR` to the folders of its
editor as well; the script refuses it otherwise, rather than guess. The script opens the
Default profile by its English name, so in an editor with another display
language, open a window with the default profile yourself.

To install by hand instead:

```sh
code --install-extension oregan-policy-manager-<version>.vsix
code --profile Default --new-window
```

The second command opens a window with the Default profile, where the extension
applies itself to all profiles; close it once the **Oregan Policy Manager**
output says so. Don't install with `--profile "<name>"`: that profile then keeps
a copy of its own, which updates never replace, so rolling stable back to an
older version would not reach it. Uninstalling, with
`code --uninstall-extension oregannetworks.oregan-policy-manager`, removes the
extension from every profile.

The CLI in VS Code 1.140 and later prints a `DeprecationWarning` about
`url.parse()` during every install. It comes from VS Code's own code, not this
extension, and is harmless; `NODE_OPTIONS=--no-deprecation` hides it. The
install script hides it.

The extension then keeps itself on the stable release (see
[Versions and updates](#versions-and-updates)). The release repository has to
be public for that check, and for the install script URLs above, to work.

## What it does

| Area | Behaviour |
|---|---|
| Profiles | Applies itself to all profiles the first time it runs, and again if that is turned off, so every window runs the policy whatever its profile |
| Telemetry | Sets `telemetry.telemetryLevel` to `"off"`, plus third-party flags such as `redhat.telemetry.enabled` where registered |
| Built-in AI | Sets `chat.disableAIFeatures: true` and `github.copilot.enable: { "*": false }`, skipping any key the host editor has not registered, and says so in a notification when it switches them off - except in a window whose workspace settings keep the AI on, where the workspace override warning shows instead |
| Copilot extensions | Uninstalls the Copilot family and the extensions that depend on it (below), and does the same again on a later reinstall |
| Drift | Restores a managed setting that is changed away from its policy value, and says so in a notification once a session. A setting something else keeps changing (5 restores in a minute, start-up included) is left alone for an hour, through a reload and in a new window too. The restores are counted across windows and extension host restarts |
| Workspace overrides | Shows an error notification while a workspace or folder setting overrides a managed setting, such as `chat.disableAIFeatures: false` in a repository's `.vscode/settings.json`, and shows it again each time it is closed until the setting is removed. **Open Workspace Settings** opens the file. Workspace and folder settings are never written |
| Settings Sync | Leaves the managed settings and extensions, and itself, out of Settings Sync (`settingsSync.ignoredSettings` and `settingsSync.ignoredExtensions`), so the policy stays on this machine and a change made on another machine doesn't come back to be put right |
| Claude Code | Recommends `anthropic.claude-code` in the **Oregan Policy Manager** output channel - nothing is installed automatically |
| Updates | Follows the stable release: checks on load and every hour, verifies the VSIX SHA-256, then installs it whenever its version differs from the running one |

All settings are written to user settings (`ConfigurationTarget.Global`).
`chat.disableAIFeatures` does not affect Claude Code, which sits outside
VS Code's built-in AI surface.

Every open window runs the extension, but only one window at a time writes
user settings, under a lock that the windows share. Windows that wrote
`settings.json` together would refuse each other's writes, and each refused
write stays in its window as unsaved changes to `settings.json`, which turn up
later as a save conflict. The policy is written once, in whichever window takes
the lock first; the others find it in place. The lock holds the process ID of
the extension host that took it, so when restoring an AI setting restarts that
host part way through, the next one takes the lock over at once.

VS Code 1.116 and later ship GitHub Copilot Chat (`GitHub.copilot-chat`) as a
built-in extension, which can't be uninstalled, and nor can a newer copy of it
from the Marketplace. The extension leaves either in place and relies on
`chat.disableAIFeatures` to switch it off; once it is off, the editor may hide
it, so the status report can show it as not installed or disabled. Uninstalling
Copilot Chat only applies before 1.116, and in forks that don't ship it.

Managed extensions, removed in this order so that `github.copilot-chat` has no
dependants left when it goes:

1. `ms-dotnettools.vscode-dotnet-modernize`
2. `vscjava.vscode-java-upgrade`
3. `github.copilot-workspace`
4. `github.copilot-nightly`
5. `github.copilot-chat`
6. `github.copilot`

When another extension that depends on one of these blocks its removal, the
warning in the output channel names it. Uninstalling that extension lets the
removal go ahead in the same window.

### Commands

| Command | Action |
|---|---|
| `Oregan: Show Policy Status` | Editor and version, each managed setting and its value, Copilot presence, Claude Code status, extension version and last update check |
| `Oregan: Check for Updates` | Runs the update check immediately |

## Versions and updates

Every installed copy follows the **stable** release, which is the one GitHub
marks **Latest** on the
[releases page](https://github.com/OreganNetworks/vscode-policy-manager/releases).
A new release is stable as soon as it is published. Stable can be rolled back to
an earlier release at any time (see [Releasing](#releasing)). "Stable" is only a
name for the release marked Latest, not a separate channel, so the
`releases/latest/download/` links that the update check and the install
scripts use always serve the stable release.

On start-up and then every hour, the extension reads `manifest.json` from the
stable release and installs that release whenever its version differs from the
running one, older or newer. A rollback therefore reaches every copy within the
hour, and offers a window reload like any other update. A copy installed by
hand that isn't the stable release, such as a local build, keeps running until
the next reload after that check.

The update is installed with the editor's own CLI (`code --install-extension`),
into the Default profile. The extension runs in every profile from there, so the
update reaches all of them whichever window does the check. Installed from a
window with another profile in any other way, it would reach that profile only.
The CLI is looked for where VS Code itself finds it: `bin/` inside the app on
macOS, and beside the editor executable on Linux and Windows. An editor without
one there gets the update through its own install command instead, with a
warning in the output channel.

Update checks are off in the Extension Development Host (F5) and the
integration suite, where the running code isn't a release.
`Oregan: Check for Updates` still runs one there.

## Supported editors

A single VSIX runs on the desktop builds of these editors, on Windows, macOS and
Linux:

| Editor | CLI | Extension source |
|---|---|---|
| VS Code | `code` | Microsoft Marketplace |
| VSCodium | `codium` | Open VSX |
| Cursor | `cursor` | Open VSX |
| Windsurf | `windsurf` | Open VSX |

Cursor and Windsurf are AI-first editors whose built-in assistants (Cursor Tab,
Windsurf Cascade) are configured outside the extension API. Neither is on the
approved register, so the extension flags them in the output channel rather
than trying to switch them off. Telemetry and Copilot handling apply in full.

The extension runs on the local side (`extensionKind: ["ui"]`), so user
settings stay put in Remote-SSH, WSL and Dev Container sessions. It also runs
in Restricted Mode (untrusted workspace) windows, because it never reads or
runs workspace content.

## Development

```sh
pnpm install
pnpm check                         # build, typecheck, lint, format:check, test
pnpm test                          # unit specs, no editor needed
xvfb-run -a pnpm test:integration  # real VS Code 1.90.0 with two fake managed extensions installed
VSCODE_TEST_VERSION=stable xvfb-run -a pnpm test:integration
pnpm package                       # oregan-policy-manager-<version>.vsix
```

Each of these is also a VS Code task (**Tasks: Run Task**), with status-bar
buttons when the recommended `actboy168.tasks` extension is installed.

Every pull request runs the `CI` workflow: lint, format, type-check, build,
unit tests, the integration suite on VS Code 1.90.0 and stable, on Linux, macOS
and Windows (including the packaged VSIX installed into a named profile, and
the install script), and a package check that the VSIX holds only the
extension. The VSIX is attached to the run
as the `vsix` artifact.

Nobody pushes to `main` directly. A pull request merges once those jobs pass
and a code owner approves its latest push: a member of the ONYX team, or one of
the repository admins outside it (`.github/CODEOWNERS`). Only ONYX and the
repository admins can merge it: the branch protection rule on `main` lets only
the ONYX team push to it, which merging is, and admins are exempt from it.
Anyone else with write access can review a pull request, but not merge it.

### Running it

Installed in your own editor, the extension applies the policy to your own
settings and extensions. Three ways to run it, from the most isolated:

| How | What runs | Where |
|---|---|---|
| F5 (**Run Extension (isolated profile)**) | The source, in an Extension Development Host | `.vscode-test/dev-user-data` and `.vscode-test/dev-extensions` |
| **Try extension (clean editor)** task | The packaged VSIX, in a separate editor that it opens | `.vscode-test/try/` - delete it to start afresh |
| **Add extension** task | The packaged VSIX, in your own editor, through the install script | The Default profile, applied to all profiles: the setup window opens, and closes again, when the extension still has to apply itself |

The two tasks package the VSIX first, then run `scripts/add-extension.mjs`.
Any separate editor works the same way: `code --user-data-dir <dir>
--extensions-dir <dir>` starts one with its own settings, extensions and
state, and leaves your own editor alone.

### Releasing

To release, bump `version` in `package.json` and merge that to `main`, then push
a matching tag on the merged commit (`v0.1.1`). Only the repository admins can
push, move or delete a `v*` tag, and the `Release` workflow refuses a tag on a
commit that isn't on `main`. It tests, packages and publishes the VSIX with its
`manifest.json` and the two install scripts, and marks the release Latest, so it
is stable straight away.

To roll stable back, or forward again, run **Promote to stable** with the
version stable should be:

```sh
run=$(gh workflow run promote.yml -f version=0.1.0) && gh run watch "${run##*/}"
```

After a reviewer approves, it checks that `v0.1.0` is published with its VSIX
and `manifest.json`, marks it Latest, and writes the version stable moved from
to the run summary, so the same command with that version undoes it. The next
tag makes its own release stable again.

The workflow runs in the `release` environment, which takes deployments from
`main` only. It stops at its first step until that environment has required
reviewers, which it gets when the repository goes public.

### Going public

The repository is private until the CSO signs off making it public. Until then
every update check gets HTTP 404, and the `release` environment can't have
required reviewers: on the GitHub Team plan they are for public repositories
only. Once it is signed off:

1. Make the repository public:

   ```sh
   gh repo edit OreganNetworks/vscode-policy-manager --visibility public --accept-visibility-change-consequences
   ```

2. Make the ONYX team the required reviewers of the `release` environment, so
   **Promote to stable** runs. Whoever starts a run can't approve it:

   ```sh
   gh api -X PUT repos/OreganNetworks/vscode-policy-manager/environments/release --input - <<'EOF'
   {
     "reviewers": [{ "type": "Team", "id": 11040468 }],
     "prevent_self_review": true,
     "can_admins_bypass": false,
     "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
   }
   EOF
   ```

3. A public repository can always be forked, so anyone can open a pull
   request; only ONYX and the admins can still merge one. Require an approval
   before CI runs on a pull request from outside the organisation:

   ```sh
   gh api -X PUT repos/OreganNetworks/vscode-policy-manager/actions/permissions/fork-pr-contributor-approval \
     -f approval_policy=all_external_contributors
   ```

4. Once there is a release, check that the update check and the install
   script can read the stable release without signing in:

   ```sh
   curl -fsSL https://github.com/OreganNetworks/vscode-policy-manager/releases/latest/download/manifest.json
   curl -fsSLI https://github.com/OreganNetworks/vscode-policy-manager/releases/latest/download/install.sh
   ```

## What it is not

This is a user-level default that is kept in place, not locked-down
enforcement: a developer can still uninstall it. Enforcement belongs to the
org-level layers - GitHub enterprise Copilot licence control and device policy
(`AllowedExtensions`, Copilot managed settings) - described under
[IDE Configuration > Enforcement beyond the repository](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/4050452495/IDE+Configuration#Enforcement-beyond-the-repository).

It covers the editor only. Nothing here reaches the terminal: GitHub's Copilot
CLI keeps working next to Claude Code, and Claude Code's own telemetry and error
reporting stay as Claude Code's settings leave them. Those belong to device
management, for example Claude Code's `managed-settings.json`.

It collects no data and reports compliance to nobody. The only outbound
requests are GETs for the release manifest and the VSIX.

## References

- [TMP-7075](https://oregannetworks.atlassian.net/browse/TMP-7075) - Disable
  GitHub Copilot in Visual Studio Code (spec and implementation plan attached)
- [ONYX-6573](https://oregannetworks.atlassian.net/browse/ONYX-6573) - Claude
  Integration
- [Agentic AI Development Policy](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/3808264194/Agentic+AI+Development+Policy)
- [IDE Configuration](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/4050452495/IDE+Configuration)
- [Agentic AI Everyday Dos and Don'ts](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/3808428033/Agentic+AI+Everyday+Dos+and+Don+ts)
