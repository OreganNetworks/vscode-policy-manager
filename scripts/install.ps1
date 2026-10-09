# Installs Oregan Policy Manager into the VS Code based editors on this machine, on Windows:
#
#   irm https://github.com/OreganNetworks/vscode-policy-manager/releases/latest/download/install.ps1 | iex
#
# For each editor it finds (VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf), it removes the copies a later
# install can't replace: any under the old ID oregan.oregan-policy-manager, and any a named profile has of its own,
# which an update would never reach.  It then installs the stable release, checked against its SHA-256, into the
# Default profile.  Unless that copy is already applied to all profiles, it opens a window with the Default profile on
# a setup file: the extension applies itself to all profiles there, and closes the window again (src/setupWindow.ts).
# install.sh does the same on macOS and Linux.
#
# Options, when the script is run as a file:
#   -Vsix <file>  install this VSIX rather than the stable release
#   -Cli <path>   only the editor with this CLI, e.g. -Cli codium.cmd
# For the integration suite: OPM_USER_DATA_DIR and OPM_EXTENSIONS_DIR point the editor given with -Cli at other
# folders, and OPM_WINDOW_ARGS adds flags to the window the script opens.

# irm | iex runs this in the session of the developer, so the body is a script block of its own: the preference,
# functions and variables it sets stay inside it.  The options come from $args, not a param block, which under iex
# would set $Vsix and $Cli in that session too.
& {
  $Vsix = ''
  $Cli = ''
  for ($i = 0; $i -lt $args.Count; $i += 2) {
    switch ($args[$i]) {
      '-Vsix' { $Vsix = $args[$i + 1] }
      '-Cli' { $Cli = $args[$i + 1] }
      default { throw "install.ps1: unknown option $($args[$i])" }
    }
  }
  $ErrorActionPreference = 'Stop'

  $ReleaseUrl = if ($env:OPM_RELEASE_URL) { $env:OPM_RELEASE_URL } else {
    'https://github.com/OreganNetworks/vscode-policy-manager/releases/latest/download'
  }
  $Id = 'oregannetworks.oregan-policy-manager'
  $OldId = 'oregan.oregan-policy-manager'
  # setupWindow.ts closes the window opened on a file with this name
  $SetupFileName = 'oregan-policy-manager-setup.txt'
  # The extension tries Apply Extension to all Profiles again after 5 and 30 seconds
  $ApplyTimeoutS = 90

  # Put back in the finally below: environment variables belong to the process, so they outlive this script block
  $savedIpcHook = $env:VSCODE_IPC_HOOK_CLI
  $savedNodeOptions = $env:NODE_OPTIONS
  # The editor CLI runs extension commands itself, not through the window of a terminal it was started from
  Remove-Item Env:VSCODE_IPC_HOOK_CLI -ErrorAction SilentlyContinue
  # The CLI of VS Code 1.140 and later prints a url.parse() deprecation warning from its own code on every install
  $env:NODE_OPTIONS = (@($env:NODE_OPTIONS, '--no-deprecation') | Where-Object { $_ }) -join ' '

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    if (-not $Vsix) {
      $manifest = Invoke-RestMethod "$ReleaseUrl/manifest.json"
      if ($manifest.vsix -notlike 'oregan-policy-manager-*.vsix') { throw 'manifest.json names no VSIX' }
      $Vsix = Join-Path $tmp $manifest.vsix
      Invoke-WebRequest "$ReleaseUrl/$($manifest.vsix)" -OutFile $Vsix -UseBasicParsing
      if ((Get-FileHash $Vsix -Algorithm SHA256).Hash -ne $manifest.sha256) {
        throw "$($manifest.vsix) does not match the SHA-256 in manifest.json"
      }
    }
    if (-not (Test-Path $Vsix)) { throw "no VSIX at $Vsix" }
    $Vsix = (Resolve-Path $Vsix).Path

    $editors = @(
      @{ Cli = 'code'; Folder = 'Microsoft VS Code'; Data = 'Code'; Extensions = '.vscode' }
      @{ Cli = 'code-insiders'; Folder = 'Microsoft VS Code Insiders'; Data = 'Code - Insiders'; Extensions = '.vscode-insiders' }
      @{ Cli = 'codium'; Folder = 'VSCodium'; Data = 'VSCodium'; Extensions = '.vscode-oss' }
      @{ Cli = 'cursor'; Folder = 'cursor\resources\app'; Data = 'Cursor'; Extensions = '.cursor' }
      @{ Cli = 'windsurf'; Folder = 'Windsurf'; Data = 'Windsurf'; Extensions = '.windsurf' }
    )

    # The CLI for an editor: on the PATH, or in the bin folder of a user or machine install
    function Find-Cli($editor) {
      $command = Get-Command "$($editor.Cli).cmd" -ErrorAction SilentlyContinue
      if ($command) { return $command.Source }
      foreach ($root in @("$env:LOCALAPPDATA\Programs", $env:ProgramFiles)) {
        $path = Join-Path $root "$($editor.Folder)\bin\$($editor.Cli).cmd"
        if (Test-Path $path) { return $path }
      }
    }

    # Runs the editor CLI, against the folders the integration suite sets when it does
    function Invoke-Cli([string]$cli, [string[]]$arguments) {
      if ($env:OPM_USER_DATA_DIR) {
        $arguments = @("--user-data-dir=$env:OPM_USER_DATA_DIR", "--extensions-dir=$env:OPM_EXTENSIONS_DIR") + $arguments
      }
      & $cli @arguments | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "$cli $($arguments -join ' ') exited with $LASTEXITCODE" }
    }

    # The entries of an extensions.json, or none.  Windows PowerShell 5.1 passes a JSON array on as one object, which
    # ForEach-Object unrolls.
    function Read-ExtensionList([string]$path) {
      if (-not (Test-Path $path)) { return @() }
      return @(Get-Content $path -Raw | ConvertFrom-Json | ForEach-Object { $_ })
    }

    function Test-Lists([string]$path, [string]$id) {
      return [bool](Read-ExtensionList $path | Where-Object { $_.identifier.id -eq $id })
    }

    function Test-Applied([string]$extensionsDir) {
      $entry = Read-ExtensionList (Join-Path $extensionsDir 'extensions.json') | Where-Object { $_.identifier.id -eq $Id }
      return [bool]($entry -and $entry.metadata.isApplicationScoped)
    }

    function Install-Into([string]$cli, [string]$dataDir, [string]$extensionsDir) {
      Write-Host $cli
      $storage = Join-Path $dataDir 'User\globalStorage\storage.json'
      $profiles = if (Test-Path $storage) { @((Get-Content $storage -Raw | ConvertFrom-Json).userDataProfiles) } else { @() }

      # Removes the copies of an extension that named profiles have of their own, and says whether there were any
      function Remove-FromNamedProfiles([string]$id) {
        $removed = $false
        foreach ($userProfile in $profiles | Where-Object { $_ }) {
          if (Test-Lists (Join-Path $dataDir "User\profiles\$($userProfile.location)\extensions.json") $id) {
            Write-Host "  removing $id from the $($userProfile.name) profile"
            Invoke-Cli $cli @('--profile', $userProfile.name, '--uninstall-extension', $id)
            $removed = $true
          }
        }
        return $removed
      }
      function Remove-FromDefaultProfile([string]$id) {
        if (Test-Lists (Join-Path $extensionsDir 'extensions.json') $id) {
          Write-Host "  removing $id"
          Invoke-Cli $cli @('--uninstall-extension', $id)
        }
      }

      # Named profiles first: from the Default profile, an uninstall of a copy applied to all profiles removes it from all
      [void](Remove-FromNamedProfiles $OldId)
      Remove-FromDefaultProfile $OldId
      # After copies of its own in named profiles, start again from nothing; otherwise --force replaces the Default copy,
      # and keeps it applied to all profiles
      if (Remove-FromNamedProfiles $Id) { Remove-FromDefaultProfile $Id }

      Write-Host "  installing $(Split-Path $Vsix -Leaf) into the Default profile"
      Invoke-Cli $cli @('--install-extension', $Vsix, '--force')
      if (Test-Applied $extensionsDir) {
        Write-Host '  applied to all profiles already: run Developer: Reload Window in open windows to start the new copy'
        return
      }

      # Outside $tmp, which is gone by the time the window shows the file
      $setup = Join-Path ([IO.Path]::GetTempPath()) $SetupFileName
      Set-Content -Path $setup -Value @(
        'Oregan Policy Manager opened this window to apply itself to all profiles, so'
        'that it runs in every window whatever its profile. The window closes by itself'
        'once that is done.'
        ''
        'If it is still open after a minute, open View > Output, pick Oregan Policy'
        'Manager, and see what it says there.'
      )
      try {
        # "Default" is the name of the default profile in an editor whose display language is English
        $windowArgs = if ($env:OPM_WINDOW_ARGS) { @($env:OPM_WINDOW_ARGS -split ' ') } else { @() }
        Invoke-Cli $cli ($windowArgs + @('--profile', 'Default', '--new-window', $setup))
      } catch {
        Write-Host '  could not open a window: open one with the Default profile, and the extension applies itself to all profiles'
        return
      }
      for ($waited = 0; $waited -lt $ApplyTimeoutS; $waited++) {
        if (Test-Applied $extensionsDir) {
          Write-Host '  applied to all profiles'
          return
        }
        Start-Sleep -Seconds 1
      }
      Write-Host "  not applied to all profiles after $ApplyTimeoutS s: see the Oregan Policy Manager output in the window it opened"
    }

    $found = 0
    if ($Cli) {
      $command = Get-Command $Cli -ErrorAction SilentlyContinue
      if (-not $command) { throw "no editor CLI at $Cli" }
      $name = [IO.Path]::GetFileNameWithoutExtension($command.Source)
      $editor = ($editors | Where-Object { $_.Cli -eq $name } | Select-Object -First 1)
      if (-not $editor) { $editor = $editors[0] }
      $dataDir = if ($env:OPM_USER_DATA_DIR) { $env:OPM_USER_DATA_DIR } else { Join-Path $env:APPDATA $editor.Data }
      $extensionsDir = if ($env:OPM_EXTENSIONS_DIR) { $env:OPM_EXTENSIONS_DIR } else {
        Join-Path $env:USERPROFILE "$($editor.Extensions)\extensions"
      }
      Install-Into $command.Source $dataDir $extensionsDir
      $found = 1
    } else {
      if ($env:OPM_USER_DATA_DIR) { throw 'OPM_USER_DATA_DIR needs -Cli' }
      foreach ($editor in $editors) {
        $path = Find-Cli $editor
        if (-not $path) { continue }
        Install-Into $path (Join-Path $env:APPDATA $editor.Data) (Join-Path $env:USERPROFILE "$($editor.Extensions)\extensions")
        $found++
      }
    }
    if ($found -eq 0) {
      throw 'found no VS Code, VS Code Insiders, VSCodium, Cursor or Windsurf: install one, or run this file with -Cli <path>'
    }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    $env:VSCODE_IPC_HOOK_CLI = $savedIpcHook
    $env:NODE_OPTIONS = $savedNodeOptions
  }
} @args
