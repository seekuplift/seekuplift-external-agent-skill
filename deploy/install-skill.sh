#!/usr/bin/env bash
# Usage: deploy/install-skill.sh <host-ip> <rendered-skill.env>
# Installs or upgrades the agent skill service on one prod host over SSH
# (user ops, key ~/.ssh/uplift_deploy — the same conventions as
# backend-rs-sql/ops/deploy/install-host.sh): ships a `git archive HEAD`
# snapshot of this repo, builds on the host (npm ci + next build as the
# meteora user), installs .env (0600 meteora) and the systemd unit, restarts,
# and waits for /skill.json to answer on 127.0.0.1:3001. Idempotent.
#
# Host prerequisites (DEPLOY.md, one-time): Node.js 20 LTS, Caddy site merged
# from deploy/Caddyfile.skill with the skill Origin CA cert installed, backend
# up on 127.0.0.1:3000. Builds into ./<pkg>.new and swaps, so a failed build
# leaves the running release untouched.
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
scp "${ssh_opts[@]}" -q "$pkg" "$envf" "$here/skill.service" "ops@$host:$stage/"
ssh "${ssh_opts[@]}" "ops@$host" sudo bash -s -- "$stage" "$(basename "$pkg")" "$(basename "$envf")" <<'REMOTE'
set -euo pipefail
stage="$1"; pkg="$2"; envf="$3"
command -v node >/dev/null || { echo "node missing — install Node.js 20 LTS first (DEPLOY.md)" >&2; exit 1; }
app=/opt/meteora/agent
work=$app.new
rm -rf "$work"
install -d -o meteora -g meteora -m 0750 "$work"
sudo -u meteora tar -xzf "$stage/$pkg" -C "$work"
install -o meteora -g meteora -m 0600 "$stage/$envf" "$work/.env"
cd "$work"
# HOME=$work: meteora is a system user without a writable home; npm needs a
# cache dir.
sudo -u meteora env HOME="$work" npm ci --no-audit --no-fund
sudo -u meteora env HOME="$work" npm run build
sudo -u meteora env HOME="$work" npm prune --omit=dev
rm -rf "$work/.npm"   # npm cache — not part of the release
if [ -d "$app" ]; then mv "$app" "$app.old"; fi
mv "$work" "$app"
rm -rf "$app.old"
install -o root -g root -m 0644 "$stage/skill.service" /etc/systemd/system/skill.service
systemctl daemon-reload
systemctl enable skill >/dev/null 2>&1
systemctl restart skill
rm -rf "$stage"
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3001/skill.json >/dev/null 2>&1 && { echo "skill healthy after ${i}s"; exit 0; }
  sleep 1
done
echo "skill not healthy after 60s" >&2; journalctl -u skill -n 40 --no-pager >&2; exit 1
REMOTE
