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
- [Supported editors](#supported-editors)
- [Development](#development)
  - [Running it](#running-it)
  - [Releasing](#releasing)
- [What it is not](#what-it-is-not)
- [References](#references)

## Install

Download `oregan-policy-manager-<version>.vsix` from the
[latest release](https://github.com/OreganNetworks/vscode-policy-manager/releases/latest)
and install it with the host editor's CLI:

```sh
code --install-extension oregan-policy-manager-<version>.vsix
```

Swap `code` for `codium`, `cursor` or `windsurf` as appropriate. It is not on
the Marketplace or Open VSX, so searching there won't find it. Once installed,
it is listed under **Installed** in the Extensions view as **Oregan Policy
Manager** (`oregan.oregan-policy-manager`), and it logs to the **Oregan Policy
Manager** channel in the Output panel. If the window was already open, run
**Developer: Reload Window**.

The CLI installs into the Default profile. If you use
[profiles](https://code.visualstudio.com/docs/configure/profiles), a window with
another profile doesn't run the extension until it is installed there too:
either add `--profile "<name>"` to the command, or open the Extensions view in
the Default profile and choose **Apply Extension to all Profiles** from the gear
menu of the extension.

The extension then checks for a new release on start-up and every hour, and
offers a window reload once one is installed. The release repository has to be
public for that check to work.

## What it does

| Area | Behaviour |
|---|---|
| Telemetry | Sets `telemetry.telemetryLevel` to `"off"`, plus third-party flags such as `redhat.telemetry.enabled` where registered |
| Built-in AI | Sets `chat.disableAIFeatures: true` and `github.copilot.enable: { "*": false }`, skipping any key the host editor has not registered |
| Copilot extensions | Uninstalls the Copilot family and the extensions that depend on it (below), and does the same again on a later reinstall |
| Drift | Restores a managed setting that is changed away from its policy value |
| Claude Code | Recommends `anthropic.claude-code` in the **Oregan Policy Manager** output channel - nothing is installed automatically |
| Updates | Checks GitHub Releases on load and every hour, verifies the VSIX SHA-256, then installs it |

All settings are written to user settings (`ConfigurationTarget.Global`).
`chat.disableAIFeatures` does not affect Claude Code, which sits outside
VS Code's built-in AI surface.

VS Code 1.138 and later ship GitHub Copilot Chat (`GitHub.copilot-chat`) as a
built-in extension, which can't be uninstalled, and nor can a newer copy of it
from the Marketplace. The extension leaves either in place and relies on
`chat.disableAIFeatures` to switch it off; once it is off, the editor may hide
it, so the status report can show it as not installed or disabled.

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
unit tests, the integration suite on VS Code 1.90.0 and stable, and a package
check that the VSIX holds only the extension. The VSIX is attached to the run
as the `vsix` artifact.

### Running it

Installed in your own editor, the extension applies the policy to your own
settings and extensions. Three ways to run it, from the most isolated:

| How | What runs | Where |
|---|---|---|
| F5 (**Run Extension (isolated profile)**) | The source, in an Extension Development Host | `.vscode-test/dev-user-data` and `.vscode-test/dev-extensions` |
| **Try extension (clean editor)** task | The packaged VSIX, in a separate editor that it opens | `.vscode-test/try/` - delete it to start afresh |
| **Add extension** task | The packaged VSIX, in your own editor | The profile you name when it asks (`Default` unless you use profiles) |

The two tasks package the VSIX first, then run `scripts/add-extension.mjs`.
Any separate editor works the same way: `code --user-data-dir <dir>
--extensions-dir <dir>` starts one with its own settings, extensions and
state, and leaves your own editor alone.

### Releasing

To release, bump `version` in `package.json`, commit, then push a matching tag
(`v0.1.1`). The `Release` workflow tests, packages and publishes the VSIX with
its `manifest.json`.

## What it is not

This is a user-level default that is kept in place, not locked-down
enforcement: a developer can still uninstall it. Enforcement belongs to the
org-level layers - GitHub enterprise Copilot licence control and device policy
(`AllowedExtensions`, Copilot managed settings) - described under
[IDE Configuration > Enforcement beyond the repository](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/4050452495/IDE+Configuration#Enforcement-beyond-the-repository).

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
