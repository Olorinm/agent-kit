#!/bin/sh
# Run as the sandbox user. Keep real directories for loaders that reject external symlinks.
#
# install.sh HOME RELEASE [--only GROUP...] [--prune] [DIR...]
#   DIR...        the skill directories to install (the bundle's own usage)
#   --only GROUP  install instead the bundle's skills whose name is GROUP or starts with GROUP-,
#                 for a caller that knows which connections this environment has
#   --prune       remove installed bundle skills the selection leaves out; user-authored skills stay
set -eu
user_home=$1
release=$2
shift 2
managing=0
pruning=0
selecting=0
sources=
groups=
for argument in "$@"; do
  case $argument in
    --prune) pruning=1 ;;
    --only) selecting=1 ;;
    --*) echo "install-skills: unknown option $argument" >&2; exit 2 ;;
    *) if [ "$selecting" = 1 ]; then groups="$groups $argument"; else sources="$sources
$argument"; fi ;;
  esac
done
if [ "$selecting" = 1 ]; then
  skills_dir=$(CDPATH= cd -- "$(dirname -- "$0")/skills" 2>/dev/null && pwd) || { echo "install-skills: no skills beside $0" >&2; exit 2; }
  for group in $groups; do
    for candidate in "$skills_dir/$group" "$skills_dir/$group"-*; do
      [ -d "$candidate" ] || continue
      sources="$sources
$candidate"
    done
  done
fi
selected=
for source in $sources; do selected="$selected|${source##*/}|"; done
for root in .agents/skills .claude/skills .gemini/config/skills .hermes/skills; do
  mkdir -p "$user_home/$root"
  for source in $sources; do
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
  # A skill this installer placed earlier and the current selection leaves out goes: the model's index should
  # list what this environment can actually do. Anything without the marker is the owner's and stays.
  if [ "$pruning" = 1 ] && [ -n "$selected" ]; then
    for target in "$user_home/$root"/*; do
      [ -d "$target" ] && [ ! -L "$target" ] || continue
      [ -f "$target/.agent-environment-version" ] || continue
      case $selected in *"|${target##*/}|"*) continue ;; esac
      rm -rf "$target"
    done
  fi
done
