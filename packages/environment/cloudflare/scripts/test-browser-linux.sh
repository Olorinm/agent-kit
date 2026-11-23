#!/bin/sh
# Run inside a disposable Debian Node container. Exercise the packaged launcher as its guest user.
set -eu
repo=$(CDPATH= cd -- "$(dirname "$0")/../../../.." && pwd)
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium-headless-shell fonts-noto-cjk
version=$(node -p 'require(process.argv[1]).dependencies["agent-browser"]' "$repo/packages/connectors/package.json")
npm install --prefix /tmp/local-browser --ignore-scripts --no-audit --no-fund "agent-browser@$version"
export LOCAL_BROWSER_TEST_CLI=/tmp/local-browser/node_modules/.bin/agent-browser
export LOCAL_BROWSER_TEST_CHROMIUM=/usr/lib/chromium/chromium-headless-shell
test -x "$LOCAL_BROWSER_TEST_CHROMIUM"
"$LOCAL_BROWSER_TEST_CLI" --version
runuser -u node --preserve-environment -- node --test "$repo/packages/environment/cloudflare/test/start-host.test.mjs"
