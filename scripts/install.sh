#!/bin/sh
# Installs Oregan Policy Manager into the VS Code based editors on this machine, on macOS and Linux:
#
#   curl -fsSL https://github.com/OreganNetworks/vscode-policy-manager/releases/latest/download/install.sh | sh
#
# For each editor it finds (VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf), it removes the copies a later
# install can't replace: any under the old ID oregan.oregan-policy-manager, and any a named profile has of its own,
# which an update would never reach.  It then installs the stable release, checked against its SHA-256, into the
# Default profile.  Unless that copy is already applied to all profiles, it opens a window with the Default profile on
# a setup file: the extension applies itself to all profiles there, and closes the window again (src/setupWindow.ts).
#
# Options, after `sh -s --` when the script is piped:
#   --vsix <file>  install this VSIX rather than the stable release
#   --cli <path>   only the editor with this CLI, e.g. --cli codium
# OPM_USER_DATA_DIR and OPM_EXTENSIONS_DIR point the editor given with --cli at other folders (the integration suite).
set -eu

RELEASE_URL=${OPM_RELEASE_URL:-https://github.com/OreganNetworks/vscode-policy-manager/releases/latest/download}
ID=oregannetworks.oregan-policy-manager
OLD_ID=oregan.oregan-policy-manager
# setupWindow.ts closes the window opened on a file with this name
SETUP_FILE_NAME=oregan-policy-manager-setup.txt
# The extension tries Apply Extension to all Profiles again after 5 and 30 seconds
APPLY_TIMEOUT_S=90

vsix=
only_cli=
while [ $# -gt 0 ]; do
  case $1 in
    --vsix) vsix=${2:?--vsix needs a file}; shift 2 ;;
    --cli) only_cli=${2:?--cli needs a path}; shift 2 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# The editor CLI runs extension commands itself, not through the window of a terminal it was started from
unset VSCODE_IPC_HOOK_CLI
# The CLI of VS Code 1.140 and later prints a url.parse() deprecation warning from its own code on every install
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-deprecation"
export NODE_OPTIONS

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# The first "key": "value" in a JSON file, as write-manifest.mjs writes one key a line
json_field() {
  sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1
}

if [ -z "$vsix" ]; then
  curl -fsSL "$RELEASE_URL/manifest.json" -o "$tmp/manifest.json" || fail "could not download $RELEASE_URL/manifest.json"
  name=$(json_field vsix "$tmp/manifest.json")
  sha256=$(json_field sha256 "$tmp/manifest.json")
  case $name in
    oregan-policy-manager-*.vsix) ;;
    *) fail "manifest.json names no VSIX" ;;
  esac
  curl -fsSL "$RELEASE_URL/$name" -o "$tmp/$name" || fail "could not download $RELEASE_URL/$name"
  [ "$(sha256_of "$tmp/$name")" = "$sha256" ] || fail "$name does not match the SHA-256 in manifest.json"
  vsix=$tmp/$name
fi
[ -f "$vsix" ] || fail "no VSIX at $vsix"

if [ "$(uname -s)" = Darwin ]; then data_root="$HOME/Library/Application Support"
else data_root=${XDG_CONFIG_HOME:-$HOME/.config}
fi

# cli|user data folder|extensions folder, for each editor
editors() {
  cat <<EOF
code|$data_root/Code|$HOME/.vscode/extensions
code-insiders|$data_root/Code - Insiders|$HOME/.vscode-insiders/extensions
codium|$data_root/VSCodium|$HOME/.vscode-oss/extensions
cursor|$data_root/Cursor|$HOME/.cursor/extensions
windsurf|$data_root/Windsurf|$HOME/.windsurf/extensions
EOF
}

# The CLI for an editor: on the PATH, or inside its app on macOS, where the launcher of every product is bin/code
find_cli() {
  if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return; fi
  case $1 in
    code) app="Visual Studio Code" ;;
    code-insiders) app="Visual Studio Code - Insiders" ;;
    codium) app=VSCodium ;;
    cursor) app=Cursor ;;
    windsurf) app=Windsurf ;;
  esac
  for dir in /Applications "$HOME/Applications"; do
    for bin in "$1" code; do
      if [ -x "$dir/$app.app/Contents/Resources/app/bin/$bin" ]; then
        printf '%s\n' "$dir/$app.app/Contents/Resources/app/bin/$bin"
        return
      fi
    done
  done
}

# Runs the editor CLI, against the folders the integration suite sets when it does
run_cli() {
  if [ -n "${OPM_USER_DATA_DIR:-}" ]; then
    "$cli" --user-data-dir="$OPM_USER_DATA_DIR" --extensions-dir="$OPM_EXTENSIONS_DIR" "$@"
  else
    "$cli" "$@"
  fi
}

# "<location> <name>" for each named profile, from the storage.json the editor writes one key a line
named_profiles() {
  [ -f "$1" ] || return 0
  awk '
    /"userDataProfiles"[[:space:]]*:/ { inside = 1; next }
    inside && /^[[:space:]]*\][[:space:]]*,?[[:space:]]*$/ { exit }
    inside && /"location"[[:space:]]*:/ { sub(/.*"location"[[:space:]]*:[[:space:]]*"/, ""); sub(/".*/, ""); location = $0 }
    inside && /"name"[[:space:]]*:/ { sub(/.*"name"[[:space:]]*:[[:space:]]*"/, ""); sub(/",?[[:space:]]*$/, ""); print location " " $0 }
  ' "$1"
}

# Whether an extensions.json lists an extension
lists() {
  [ -f "$1" ] && grep -qiF "\"id\":\"$2\"" "$1"
}

# Whether the extensions.json of the Default profile lists this extension as applied to all profiles
applied_to_all_profiles() {
  [ -f "$1" ] || return 1
  tr '{' '\n' <"$1" | awk -v id="\"id\":\"$ID\"" '
    { line = tolower($0) }
    index(line, "\"id\":") == 1 { mine = index(line, id) == 1 }
    mine && index(line, "\"isapplicationscoped\":true") { found = 1 }
    END { exit !found }
  '
}

# Removes the copies of an extension that named profiles have of their own, and says whether there were any
remove_from_named_profiles() {
  removed=$tmp/removed
  rm -f "$removed"
  named_profiles "$data_dir/User/globalStorage/storage.json" | while read -r location name; do
    if lists "$data_dir/User/profiles/$location/extensions.json" "$1"; then
      say "  removing $1 from the $name profile"
      run_cli --profile "$name" --uninstall-extension "$1" >/dev/null
      : >"$removed"
    fi
  done
  [ -f "$removed" ]
}

remove_from_default_profile() {
  if lists "$extensions_dir/extensions.json" "$1"; then
    say "  removing $1"
    run_cli --uninstall-extension "$1" >/dev/null
  fi
}

install_into() {
  cli=$1 data_dir=$2 extensions_dir=$3
  say "$cli"
  # Named profiles first: from the Default profile, an uninstall of a copy applied to all profiles removes it from all
  remove_from_named_profiles "$OLD_ID" || true
  remove_from_default_profile "$OLD_ID"
  # After copies of its own in named profiles, start again from nothing; otherwise --force replaces the Default copy,
  # and keeps it applied to all profiles
  if remove_from_named_profiles "$ID"; then remove_from_default_profile "$ID"; fi

  say "  installing $(basename "$vsix") into the Default profile"
  run_cli --install-extension "$vsix" --force >/dev/null
  if applied_to_all_profiles "$extensions_dir/extensions.json"; then
    say "  applied to all profiles already: run Developer: Reload Window in open windows to start the new copy"
    return
  fi

  # Outside $tmp, which is gone by the time the window shows the file
  setup="${TMPDIR:-/tmp}/$SETUP_FILE_NAME"
  cat >"$setup" <<'EOF'
Oregan Policy Manager opened this window to apply itself to all profiles, so
that it runs in every window whatever its profile. The window closes by itself
once that is done.

If it is still open after a minute, open View > Output, pick Oregan Policy
Manager, and see what it says there.
EOF
  # "Default" is the name of the default profile in an editor whose display language is English
  if ! run_cli --profile Default --new-window "$setup" >/dev/null 2>&1; then
    say "  could not open a window: open one with the Default profile, and the extension applies itself to all profiles"
    return
  fi
  waited=0
  until applied_to_all_profiles "$extensions_dir/extensions.json"; do
    if [ $waited -ge $APPLY_TIMEOUT_S ]; then
      say "  not applied to all profiles after $APPLY_TIMEOUT_S s: see the Oregan Policy Manager output in the window it opened"
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done
  say "  applied to all profiles"
}

found=0
if [ -n "$only_cli" ]; then
  cli_path=$(command -v "$only_cli" || true)
  [ -n "$cli_path" ] || fail "no editor CLI at $only_cli"
  match=$(editors | grep "^$(basename "$only_cli" .cmd)|" || editors | head -n 1)
  data_dir=${OPM_USER_DATA_DIR:-$(printf '%s' "$match" | cut -d '|' -f 2)}
  extensions_dir=${OPM_EXTENSIONS_DIR:-$(printf '%s' "$match" | cut -d '|' -f 3)}
  install_into "$cli_path" "$data_dir" "$extensions_dir"
  found=1
else
  [ -z "${OPM_USER_DATA_DIR:-}" ] || fail "OPM_USER_DATA_DIR needs --cli"
  while IFS='|' read -r name data_dir extensions_dir; do
    cli_path=$(find_cli "$name")
    [ -n "$cli_path" ] || continue
    install_into "$cli_path" "$data_dir" "$extensions_dir"
    found=$((found + 1))
  done <<EOF
$(editors)
EOF
fi
[ "$found" -gt 0 ] || fail "found no VS Code, VS Code Insiders, VSCodium, Cursor or Windsurf: install one, or give --cli <path>"
