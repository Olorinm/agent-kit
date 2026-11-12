#!/bin/sh
# Upload this last, to /opt/agent-environment/start.sh. The gateway entrypoint
# waits for this file. Package and credentials are supplied separately by Mau.
set -eu
# Installed program files must be traversable by the unprivileged Host user.
# Mau separately writes credentials and service tokens with mode 0600.
umask 022
base=/opt/agent-environment
host_dir=/home/user/.agent-host-service
export PATH="/opt/agent-host/node_modules/.bin:/opt/codex/node_modules/.bin:$PATH"
export HOME=/home/user

if [ ! -f "$base/host-installed" ]; then
  # Native Rust clients require the system CA bundle; Node's bundled trust
  # store alone does not provide HTTPS verification for the native CLI.
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates git tini util-linux
  sha256sum -c "$base/agent-host.sha256"
  npm install --prefix /opt/agent-host --omit=dev "$base/agent-host.tgz"
  npm install --prefix /opt/codex @openai/codex@0.162.1
  id user >/dev/null 2>&1 || useradd --create-home --uid 1001 user
  mkdir -p /home/user/workspace "$host_dir"
  touch "$base/host-installed"
fi

# Mau writes the hash-checked readiness manifest after the private files.
while [ ! -f "$host_dir/ready.json" ]; do sleep 1; done
chown -R user:user /home/user
exec tini -- runuser -u user -- agent-host serve \
  --config "$host_dir/host.json" --token-file "$host_dir/token" \
  --ready-file "$host_dir/ready.json" --host 0.0.0.0 --port 37420
