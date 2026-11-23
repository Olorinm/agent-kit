#!/bin/sh
# Upload this last, to /opt/agent-environment/start.sh. The gateway entrypoint
# waits for this file. Package and credentials are supplied separately by Mau.
set -eu
# Installed program files must be traversable by the unprivileged Host user.
# Mau separately writes credentials and service tokens with mode 0600.
umask 022
base=/opt/agent-environment
host_dir=/home/user/.agent-host-service
export PATH="/opt/agy-1.5.15/bin:/opt/dsh/node_modules/.bin:/opt/agent-host/node_modules/.bin:/opt/codex/node_modules/.bin:$PATH"
export HOME=/home/user

if [ ! -f "$base/host-installed" ]; then
  # Native Rust clients require the system CA bundle; Node's bundled trust
  # store alone does not provide HTTPS verification for the native CLI.
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates git tini util-linux
  sha256sum -c "$base/agent-host.sha256"
  npm install --prefix /opt/agent-host --omit=dev "$base/agent-host.tgz"
  id user >/dev/null 2>&1 || useradd --create-home --uid 1001 user
  mkdir -p /home/user/workspace "$host_dir"
  touch "$base/host-installed"
fi

# A restored sandbox may have a previously installed Codex under the same prefix.
codex_version=0.171.0
if [ "$(node -p 'require("/opt/codex/node_modules/@openai/codex/package.json").version' 2>/dev/null || true)" != "$codex_version" ]; then
  npm install --prefix /opt/codex "@openai/codex@$codex_version"
fi

# GH_TOKEN is a placeholder installed by the gateway on creation and snapshot restore.
if [ "${GH_TOKEN:-}" = gateway-managed ] && ! command -v gh >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends gh
fi
# A browser inside this environment, for the pages the Agent serves here, which a
# browser outside cannot reach: Debian's headless Chromium, and the official
# agent-browser CLI, unmodified, at the version Agent Connectors pins. Run it as
# /opt/local-browser/agent-browser; /usr/local/bin/agent-browser is Mau's and is
# left alone. Installed in the background, some 285 MB to download, so Host does
# not wait for it. An install cut short by a pause is completed at the next start.
if [ ! -f "$base/local-browser-installed" ]; then
  (
    exec >/var/log/local-browser-install.log 2>&1
    dpkg --configure -a
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends \
      chromium-headless-shell fonts-liberation fonts-noto-cjk fonts-noto-color-emoji
    # The package carries a binary for every platform, so its install script has nothing to fetch. Keep this machine's.
    npm install --prefix /opt/local-browser --ignore-scripts --no-audit --no-fund agent-browser@0.41.2
    case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=x64 ;; esac
    cd /opt/local-browser/node_modules/agent-browser/bin
    find . -type f ! -name "agent-browser-linux-$arch" -delete
    chmod 755 "agent-browser-linux-$arch"
    ln -sf "agent-browser-linux-$arch" agent-browser
    # Written last: this file is there once the browser and the CLI are.
    cat > /opt/local-browser/agent-browser.new <<'LAUNCHER'
#!/bin/sh
# The official agent-browser CLI with the settings it needs for the Chromium installed in this environment.
# Written by the environment's start script. Arguments pass through unchanged.
export AGENT_BROWSER_EXECUTABLE_PATH=/usr/lib/chromium/chromium-headless-shell
# Chromium's own sandbox needs unprivileged user namespaces or a setuid helper, and a container grants
# neither to a user other than root; the environment is the boundary. /dev/shm in a container is small.
# The CLI adds these two itself only where it recognises root or Docker. One argument per line.
export AGENT_BROWSER_ARGS="--no-sandbox
--disable-dev-shm-usage${AGENT_BROWSER_ARGS:+
$AGENT_BROWSER_ARGS}"
# The check for an outdated Chrome asks a site on the internet, which this environment does not reach.
export AGENT_BROWSER_NO_VERSION_CHECK=1
exec /opt/local-browser/node_modules/agent-browser/bin/agent-browser "$@"
LAUNCHER
    chmod 755 /opt/local-browser/agent-browser.new
    mv /opt/local-browser/agent-browser.new /opt/local-browser/agent-browser
    touch "$base/local-browser-installed"
  ) &
fi

# Mau writes the hash-checked readiness manifest after the private files.
while [ ! -f "$host_dir/ready.json" ]; do sleep 1; done

uses_kernel() {
  node -e 'const profile = require(process.argv[1]); process.exit(profile.runtimes.some(r => r.kernel === process.argv[2]) ? 0 : 1)' "$host_dir/host.json" "$1"
}

# Google publishes the release paths and SHA-512 digests in its platform-specific CLI manifests.
if uses_kernel agy && [ ! -x /opt/agy-1.5.15/bin/agy ]; then
  case "$(dpkg --print-architecture)" in
    amd64) payload=linux-x64/cli_linux_x64.tar.gz; digest=af3f0be58b8475940d79f9abea19e762ecc3d265ea9f56cff8dd805e27ba299b44a305a79504a7ffe6ebdfa29a294c56edc4caed1875990bfaf2fef1508ec8b0 ;;
    arm64) payload=linux-arm/cli_linux_arm64.tar.gz; digest=d64ad759781b50dfacfa7d9826c0ad469959d01bdf5a170acd4c83472eba31c677baf0052ac8ab48eef40f0d3f0e26057e752aabd24331c79f4c881d4b872125 ;;
    *) echo "Unsupported Antigravity architecture" >&2; exit 1 ;;
  esac
  package_url="https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/$payload"
  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' EXIT
  node --input-type=module - "$package_url" "$staging/agy.tgz" <<'DOWNLOAD'
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
const response = await fetch(process.argv[2], { redirect: "error" });
if (!response.ok) throw new Error("Antigravity download failed: " + response.status);
await pipeline(response.body, createWriteStream(process.argv[3]));
DOWNLOAD
  echo "$digest  $staging/agy.tgz" | sha512sum -c -
  tar -xzf "$staging/agy.tgz" -C "$staging" antigravity
  install -d /opt/agy-1.5.15/bin
  install -m 755 "$staging/antigravity" /opt/agy-1.5.15/bin/agy.new
  /opt/agy-1.5.15/bin/agy.new --version
  mv /opt/agy-1.5.15/bin/agy.new /opt/agy-1.5.15/bin/agy
  rm -rf "$staging"
  trap - EXIT
fi

if uses_kernel dsh; then
  if [ ! -f "$base/dsh-installed-0.2.2-rc.5" ]; then
    npm install --prefix /opt/dsh --omit=dev --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.5
    dsh --version
    touch "$base/dsh-installed-0.2.2-rc.5"
  fi
fi
# Mau supplies the pinned offline skill bundle before publishing this start script.
skills_digest=09c3d39cd7091881f1cc3dd9d2a2175a3a545847bb7f542f57e5c16b18c84d19
skills_store=/opt/agent-environment-skills
skills_path="$skills_store/$skills_digest"
if [ -f "$base/official-skills.tgz" ] && [ ! -d "$skills_path" ]; then
  printf '%s  %s\n' "$skills_digest" "$base/official-skills.tgz" | sha256sum -c -
  install -d -m 755 "$skills_store"
  temp_skills=$(mktemp -d "$skills_store/.skills-XXXXXX")
  tar xzf "$base/official-skills.tgz" -C "$temp_skills"
  chmod 755 "$temp_skills"
  mv "$temp_skills" "$skills_path"
fi
chown -R user:user /home/user
if [ -d "$skills_path" ]; then
  ln -sfnT "$skills_path" "$skills_store/current"
  # What Mau asks the installer for later: only the skill groups this environment has connections for.
  printf '%s\n' "$skills_digest" > "$skills_store/digest"
  chmod 644 "$skills_store/digest"
  runuser -u user -- sh "$skills_path/install.sh" /home/user "$skills_digest" "$skills_path"/skills/*
  if [ -f "$base/mau-sandbox/SKILL.md" ]; then
    install -d -m 755 "$skills_store/mau-sandbox"
    install -m 644 "$base/mau-sandbox/SKILL.md" "$skills_store/mau-sandbox/SKILL.md"
    addendum_digest=$(sha256sum "$base/mau-sandbox/SKILL.md" | cut -d ' ' -f 1)
    runuser -u user -- sh "$skills_path/install.sh" /home/user "$addendum_digest" "$skills_store/mau-sandbox"
  fi
fi
if [ "${GH_TOKEN:-}" = gateway-managed ]; then
  # Some harnesses filter *TOKEN* variables from their shells. The official CLI also reads hosts.yml.
  runuser -u user -- sh -c 'set -eu; umask 077; mkdir -p "$HOME/.config/gh"
    if [ ! -e "$HOME/.config/gh/hosts.yml" ]; then
      printf "github.com:\n    oauth_token: gateway-managed\n    git_protocol: https\n" > "$HOME/.config/gh/hosts.yml"
    fi'
fi
exec tini -- runuser -u user -- agent-host serve \
  --config "$host_dir/host.json" --token-file "$host_dir/token" \
  --ready-file "$host_dir/ready.json" --host 0.0.0.0 --port 37420
