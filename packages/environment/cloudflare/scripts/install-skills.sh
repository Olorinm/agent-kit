#!/bin/sh
# The guest's Debian perl-base (also on macOS for tests) provides a kernel-released lock.
# Hold the home directory itself open so a crash leaves no stale lock file.
set -eu
[ -d "$1" ] && [ ! -L "$1" ] || { echo "install-skills: expected a real home directory" >&2; exit 2; }
exec perl -MFcntl=:flock -e 'flock(STDIN, LOCK_EX) or die "lock home: $!"; exec @ARGV or die "exec: $!"' \
  node "$(dirname "$0")/install.mjs" "$@" < "$1"
