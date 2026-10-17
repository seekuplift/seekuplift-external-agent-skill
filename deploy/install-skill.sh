#!/usr/bin/env bash
# Usage: deploy/install-skill.sh <host-ip> <rendered-skill.env>
# Installs or upgrades the agent skill service on one prod host over SSH
# (user ops, key ~/.ssh/uplift_deploy — the same conventions as
# backend-rs-sql/ops/deploy/install-host.sh): ships a `git archive HEAD`
# snapshot of this repo, creates the dedicated `skill` system user, builds on
# the host (npm ci + next build as `skill`, memory-capped), installs .env
# (0600 skill), the systemd unit and the Caddy site (/etc/caddy/conf.d/skill.caddy),
# restarts, and waits for /skill.json on 127.0.0.1:3010. Idempotent.
#
# Host prerequisites (DEPLOY.md, one-time): Node.js 24 LTS; the skill Origin CA
# cert at /etc/caddy/skill-origin.{pem,key}; the backend's Caddyfile deployed
# FIRST (it carries `import /etc/caddy/conf.d/*.caddy`); backend up on
# 127.0.0.1:3000. Builds into /opt/skill.new and swaps, keeping the previous
# release as /opt/skill.prev, so a failed build leaves the running release
# untouched. Rollback (on the host, as root):
#   mv /opt/skill /opt/skill.bad && mv /opt/skill.prev /opt/skill && systemctl restart skill
set -euo pipefail
host="$1"; envf="$2"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
ssh_opts=(-i "$HOME/.ssh/uplift_deploy" -o ConnectTimeout=15)
stage=/tmp/meteora-skill-stage
pkg="$(mktemp -u /tmp/meteora-skill-src.XXXXXX.tar.gz)"
trap 'rm -f "$pkg"' EXIT
git -C "$root" archive --format=tar.gz -o "$pkg" HEAD
ssh "${ssh_opts[@]}" "ops@$host" "rm -rf $stage && mkdir -m 700 $stage"
scp "${ssh_opts[@]}" -q "$pkg" "$envf" "$here/skill.service" "$here/Caddyfile.skill" "ops@$host:$stage/"
ssh "${ssh_opts[@]}" "ops@$host" sudo bash -s -- "$stage" "$(basename "$pkg")" "$(basename "$envf")" <<'REMOTE'
set -euo pipefail
stage="$1"; pkg="$2"; envf="$3"
command -v node >/dev/null || { echo "node missing — install Node.js 24 LTS first (DEPLOY.md)" >&2; exit 1; }
# engines.node pins the major — a wrong major ships a different toolchain than
# the lockfile was generated against.
[ "$(node -p 'process.versions.node.split(".")[0]')" = "24" ] \
  || { echo "node $(node --version) — package.json engines require major 24" >&2; exit 1; }

# Preflight (nothing on the host has changed yet).
[ -d /etc/caddy/conf.d ] && grep -q '^import /etc/caddy/conf.d/' /etc/caddy/Caddyfile \
  || { echo "backend Caddyfile with the conf.d import is not deployed — run backend-rs-sql ops/deploy/install-host.sh first" >&2; exit 1; }
[ -s /etc/caddy/skill-origin.pem ] && [ -s /etc/caddy/skill-origin.key ] \
  || { echo "/etc/caddy/skill-origin.{pem,key} missing — DEPLOY.md 'One-time: origin certificate on each host'" >&2; exit 1; }
avail=$(free -m | awk '/^Mem:/ {print $7}')
if [ "$avail" -lt 1800 ]; then
  echo "only ${avail} MB RAM available (need >= 1800 MB for next build next to the backend); build off-host instead (DEPLOY.md 'Building off-host')" >&2
  exit 1
fi

# Dedicated unprivileged user — no access to the backend's secrets/DB env.
id skill >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin skill

# /opt/skill, not under /opt/meteora (the meteora user's home).
app=/opt/skill
work=$app.new
rm -rf "$work"
install -d -o skill -g skill -m 0750 "$work"
sudo -u skill tar -xzf "$stage/$pkg" -C "$work"
install -o skill -g skill -m 0600 "$stage/$envf" "$work/.env"
cd "$work"
# HOME=$work: skill has no home; npm needs a cache dir. The scope caps the
# build's memory so an OOM kills the build, not the backend.
build() { systemd-run --scope -q -p MemoryMax=1500M -p MemorySwapMax=0 -- \
  sudo -u skill env HOME="$work" NODE_OPTIONS=--max-old-space-size=1024 "$@"; }
build npm ci --no-audit --no-fund
build npm run build
sudo -u skill env HOME="$work" npm prune --omit=dev
rm -rf "$work/.npm"   # npm cache — not part of the release

# Caddy site: full-config validate before it goes live.
check=$(mktemp -d)
trap 'rm -rf "$check"' EXIT
find /etc/caddy/conf.d -maxdepth 1 -name '*.caddy' ! -name skill.caddy -exec cp -t "$check" {} +
cp "$stage/Caddyfile.skill" "$check/skill.caddy"
sed "s#^import /etc/caddy/conf.d/\*\.caddy#import $check/*.caddy#" /etc/caddy/Caddyfile > "$check/Caddyfile"
caddy validate --config "$check/Caddyfile" --adapter caddyfile >/dev/null
caddy_changed=1
cmp -s "$stage/Caddyfile.skill" /etc/caddy/conf.d/skill.caddy && caddy_changed=0
if [ "$caddy_changed" = 1 ]; then
  install -o root -g root -m 0644 "$stage/Caddyfile.skill" /etc/caddy/conf.d/.skill.caddy.tmp
  mv -f /etc/caddy/conf.d/.skill.caddy.tmp /etc/caddy/conf.d/skill.caddy
fi

# Swap releases (keep the previous one for rollback).
rm -rf "$app.prev"
[ -d "$app" ] && mv "$app" "$app.prev"
mv "$work" "$app"
install -o root -g root -m 0644 "$stage/skill.service" /etc/systemd/system/skill.service
systemctl daemon-reload
systemctl enable skill >/dev/null 2>&1
systemctl restart skill
[ "$caddy_changed" = 1 ] && systemctl reload caddy
rm -rf "$stage"
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3010/skill.json >/dev/null 2>&1 && { echo "skill healthy after ${i}s"; exit 0; }
  sleep 1
done
echo "skill not healthy after 60s" >&2; journalctl -u skill -n 40 --no-pager >&2; exit 1
REMOTE
