# Oregan Policy Manager

An internally distributed editor extension (`oregan.oregan-policy-manager`)
that keeps every Oregan developer's editor aligned with our NDA commitments and
the
[Agentic AI Development Policy](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/3808264194/Agentic+AI+Development+Policy)
(POL-SEC-AI-002):

- **Telemetry off**, so no editor usage data leaves the machine.
- **GitHub Copilot off** - Copilot is not on the Section 5 approved register.
- **Claude Code recommended** as the approved assistant (Claude for Teams).

It replaces the per-repository `.vscode` rollout started on the
[IDE Configuration](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/4050452495/IDE+Configuration)
page, which was paused before any repository took it. One install per machine
applies the same settings at user level, across every workspace and every
repository host (GitHub, Bitbucket and Zenterio alike), and keeps them in
place.

> **Status:** pre-implementation. The design is the v0.4 spec and delivery plan
> attached to [TMP-7075](https://oregannetworks.atlassian.net/browse/TMP-7075).

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

Managed extensions, removed in this order so that `github.copilot-chat` has no
dependants left when it goes:

1. `ms-dotnettools.vscode-dotnet-modernize`
2. `vscjava.vscode-java-upgrade`
3. `github.copilot-workspace`
4. `github.copilot-nightly`
5. `github.copilot-chat`
6. `github.copilot`

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
settings stay put in Remote-SSH, WSL and Dev Container sessions.

## Install

Not released yet. Once it is, releases will be published at
<https://github.com/OreganNetworks/vscode-policy-manager/releases> and installed
with the host editor's CLI:

```sh
code --install-extension oregan-policy-manager-<version>.vsix
```

Swap `code` for `codium`, `cursor` or `windsurf` as appropriate. The extension
keeps itself up to date after that.

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
  GitHub Copilot in Visual Studio Code (spec and delivery plan attached)
- [ONYX-6573](https://oregannetworks.atlassian.net/browse/ONYX-6573) - Claude
  Integration
- [Agentic AI Development Policy](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/3808264194/Agentic+AI+Development+Policy)
- [IDE Configuration](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/4050452495/IDE+Configuration)
- [Agentic AI Everyday Dos and Don'ts](https://oregannetworks.atlassian.net/wiki/spaces/AI/pages/3808428033/Agentic+AI+Everyday+Dos+and+Don+ts)
