#!/bin/sh
# Run as the sandbox user. Keep real directories for loaders that reject external symlinks.
set -eu
user_home=$1
release=$2
shift 2
for root in .agents/skills .claude/skills .gemini/config/skills .hermes/skills; do
  mkdir -p "$user_home/$root"
  for source; do
    name=${source##*/}
    target="$user_home/$root/$name"
    marker="$target/.agent-environment-version"
    if [ -e "$target" ] || [ -L "$target" ]; then
      [ -d "$target" ] && [ ! -L "$target" ] && [ -f "$marker" ] || continue
      [ "$(cat "$marker")" != "$release" ] || continue
    fi
    # Stage beside the skills root, outside discovery. An interrupted install is repaired at next startup.
    temp=$(mktemp -d "$user_home/${root%/*}/.agent-environment-install-XXXXXX")
    cp -R "$source" "$temp/new"
    printf '%s\n' "$release" > "$temp/new/.agent-environment-version"
    if [ -d "$target" ]; then mv "$target" "$temp/previous"; fi
    mv "$temp/new" "$target"
    rm -rf "$temp"
  done
done
