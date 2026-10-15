# Deployment Guide

## Local Development

```bash
cd agent
cp .env.example .env.local   # already pre-filled if you ran setup
npm install
npm run dev                   # http://localhost:3001
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BACKEND_URL` | Yes | backend-rs-sql base URL — the mobile-config source, pool listing, AND the IPFS upload proxy (`/api/upload/*`); the backend owns the Filebase credentials, this service holds none. Default: `http://localhost:3000`. In the colocated deployment the service calls it over loopback (`http://127.0.0.1:3000`) and forwards each caller's IP as `X-Forwarded-For` (the backend trusts XFF only from `127.0.0.1`), so geo verdicts and the 10/hour upload limit apply per calling agent. |
| `SOLANA_RPC_URL` | No | Solana mainnet RPC endpoint. Default: `https://api.mainnet-beta.solana.com` |
| `DONATION_CLAIM_AUTHORITIES` | No | Comma-separated donation claim authorities (config `feeClaimer` values that make a launch config cause-capable). Must mirror the app's `config/production-manifest.json` → `targets.production.donationClaimAuthorities` (`EXPO_PUBLIC_DONATION_CLAIM_AUTHORITY`); update it whenever the app's value changes or new configs ship. Unset/empty → no config is cause-capable. |

For production, use a private RPC (Helius, QuickNode, Triton) to avoid rate limits on `POST /api/launch` and `/api/trade/*` — those make multiple RPC calls per request.

---

## Production — colocated on hosts A+B (recommended)

The service runs on the same prod hosts as backend-rs-sql, behind a third
Caddy site on the same Cloudflare load balancer:

```
Cloudflare LB → skill.seekuplift.com → Caddy :443 → 127.0.0.1:3010 (this service)
                                                    → 127.0.0.1:3000 (backend-rs-sql)
```

Host addresses, SSH user (`ops`) and deploy key (`~/.ssh/uplift_deploy`) follow
the backend's conventions — see `backend-rs-sql/ops/deploy/README.md` for host
A/B IPs. The service itself runs as its own `skill` system user from
`/opt/skill` (created by `install-skill.sh`), with no access to `/opt/meteora`
(backend `.env`, obs stack). Port 3010 is loopback-only (Grafana owns 3001 on
host A).
Deploy artifacts live in `deploy/` in this repo:

| File | Use |
|---|---|
| `deploy/Caddyfile.skill` | `skill.seekuplift.com` site block — installed by `install-skill.sh` as `/etc/caddy/conf.d/skill.caddy`, imported by the backend's Caddyfile (which owns `/etc/caddy/Caddyfile`). Replaces inbound `X-Forwarded-For` with `CF-Connecting-IP` so `clientIpFromHeaders`' first-hop read is the real caller IP. |
| `deploy/skill.service` | systemd unit — `next start` bound to `127.0.0.1:3010`, runs as user `skill`, env file, `MemoryMax=768M`, restart policy, hardening, `/opt/meteora` hidden. Loopback-only is load-bearing: a public bind would let callers bypass Caddy's XFF rewrite and spoof their IP to the backend. |
| `deploy/skill.env.template` | Template for `/opt/skill/.env` (0600, owner `skill`). |
| `deploy/install-skill.sh` | Install/upgrade one host: `git archive HEAD` snapshot → memory-checked, memory-capped build on host → `.env` + unit + Caddy site → restart → health check. Keeps the previous release as `/opt/skill.prev`. |

**Human gate:** the steps below run on production hosts and touch Cloudflare.
They are recorded here exactly; the actual deploy and DNS change are
owner-run.

### One-time per host: Node.js 20 LTS

The backend hosts ship no Node runtime:

```bash
ssh -i ~/.ssh/uplift_deploy ops@<HOST>
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v20.x
```

`install-skill.sh` builds on the host inside `systemd-run --scope -p
MemoryMax=1500M` (an OOM kills the build, not the backend) and refuses to start
if `free -m` shows < 1800 MB available. If a host cannot spare that, see
"Building off-host" below.

### One-time: Cloudflare DNS + origin certificate

1. In Cloudflare → `seekuplift.com` → DNS: add a **proxied** CNAME `skill` →
   `app-api.seekuplift.com` (same pattern as `updates.seekuplift.com` — both
   pools A+B come along with the same LB hostname).
2. Cloudflare → SSL/TLS → Origin Server: create an Origin CA certificate
   covering `skill.seekuplift.com` (or a `*.seekuplift.com` cert). Save it to
   the operator machine as `~/.config/seekuplift/skill-origin.pem` /
   `skill-origin.key` (0600). SSL mode stays Full (strict).

### One-time per host: origin certificate

The skill's Caddy site is **not** appended to `/etc/caddy/Caddyfile` (the
backend's `install-host.sh` overwrites that file on every deploy). Instead the
backend Caddyfile has `import /etc/caddy/conf.d/*.caddy`, and `install-skill.sh`
installs `deploy/Caddyfile.skill` as `/etc/caddy/conf.d/skill.caddy`
(full-config `caddy validate` first, then atomic move + reload; unchanged
content is left alone). **Deploy the backend Caddyfile (with the import line,
`ops/deploy/install-host.sh` or `install-updates-site.sh`) to the host first**;
`install-skill.sh` refuses otherwise. The backend install never touches
`/etc/caddy/skill-origin.*` or `conf.d/`.

```bash
scp -i ~/.ssh/uplift_deploy ~/.config/seekuplift/skill-origin.pem \
    ~/.config/seekuplift/skill-origin.key ops@<HOST>:/tmp/
ssh -i ~/.ssh/uplift_deploy ops@<HOST> sudo bash <<'REMOTE'
set -euo pipefail
install -o root -g caddy -m 0640 /tmp/skill-origin.pem /etc/caddy/skill-origin.pem
install -o root -g caddy -m 0640 /tmp/skill-origin.key /etc/caddy/skill-origin.key
rm -f /tmp/skill-origin.pem /tmp/skill-origin.key
REMOTE
```

### Per deploy: env file + install (B first, then A)

Render the env file locally — never commit it:

```bash
cp deploy/skill.env.template /tmp/skill.env
$EDITOR /tmp/skill.env
#   BACKEND_URL=http://127.0.0.1:3000        (loopback — do not change)
#   SOLANA_RPC_URL=<private mainnet RPC>
#   DONATION_CLAIM_AUTHORITIES=<see "Config tracking" below>
```

Then install both hosts (B first, matching the backend's upgrade order):

```bash
deploy/install-skill.sh <HOST_B> /tmp/skill.env
deploy/install-skill.sh <HOST_A> /tmp/skill.env
shred -u /tmp/skill.env
```

The script ships `git archive HEAD` — commit before deploying so the hosts run
a recorded tree.

### Verify

```bash
ssh -i ~/.ssh/uplift_deploy ops@<HOST> 'systemctl status skill --no-pager; \
  curl -s http://127.0.0.1:3010/skill.json | head; ss -ltnp | grep 3010'
curl -s https://skill.seekuplift.com/skill.json        # via Cloudflare
curl -s https://skill.seekuplift.com/api/configs | head
```

`GET /api/configs` returning entries proves the loopback call to the backend
works; `geo.allowed` varying by caller IP proves the XFF chain works.

### Config tracking — `DONATION_CLAIM_AUTHORITIES`

`DONATION_CLAIM_AUTHORITIES` must track the app's
`config/production-manifest.json` → `targets.production.donationClaimAuthorities`
(`EXPO_PUBLIC_DONATION_CLAIM_AUTHORITY`) **whenever new configs ship** — a
cause-capable config whose `feeClaimer` is absent from the env silently reads
as `supportsCause: false`. Update `.env` on both hosts and
`systemctl restart skill` (the value is read per call, but the env file is
only loaded at start).

### Upgrade

```bash
git pull --ff-only
deploy/install-skill.sh <HOST_B> /tmp/skill.env
deploy/install-skill.sh <HOST_A> /tmp/skill.env
```

Rollback (previous release is kept as `/opt/skill.prev`):

```bash
ssh -i ~/.ssh/uplift_deploy ops@<HOST> 'sudo sh -c "mv /opt/skill /opt/skill.bad && mv /opt/skill.prev /opt/skill && systemctl restart skill"'
```

Or redeploy an older SHA (`git archive` runs on `HEAD`, so check it out first).
The service is stateless — no data migration.

### Building off-host

If a host lacks the RAM headroom for `next build`, build on a same-arch
(linux x64) machine with the same Node major: `npm ci && npm run build && npm
prune --omit=dev`, tar the tree (including `.next/` and `node_modules/`, plus a
`.env`), and unpack it into `/opt/skill.new` owned by `skill:skill` on the host,
then follow the swap/restart steps in `install-skill.sh` by hand (the script
currently always builds on the host).

### Status

Deployment to hosts A+B and the Cloudflare DNS/origin-cert steps are
**blocked-on-owner** — the artifacts and commands above are prepared but not
executed.

---

## Railway / Render / Fly.io (alternative self-hosted)

These platforms run a Node.js process directly. This path is NOT the
production deployment: off-host, the backend will not trust this service's
`X-Forwarded-For`, so geo verdicts and the upload budget resolve against the
platform's egress IP, not the caller's.

```bash
# Build
npm run build

# Start (binds to $PORT or 3001)
PORT=3001 npm start
```

Set environment variables via the platform's dashboard or CLI. Example for Railway:

```bash
railway variables set SOLANA_RPC_URL=... BACKEND_URL=...
```

---

## Docker (alternative self-hosted)

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/SKILL.md ./SKILL.md
EXPOSE 3001
ENV PORT=3001
CMD ["node", "server.js"]
```

Enable standalone output in `next.config.js` before building with Docker:

```js
const nextConfig = {
  output: 'standalone',
  experimental: { serverComponentsExternalPackages: [...] },
}
```

Build and run:

```bash
docker build -t seekuplift-agent-skill .
docker run -p 3001:3001 \
  -e SOLANA_RPC_URL=... \
  -e BACKEND_URL=... \
  seekuplift-agent-skill
```

---

## Production Checklist

- [ ] Private Solana RPC set (`SOLANA_RPC_URL`) — public endpoint rate-limits aggressively
- [ ] `BACKEND_URL=http://127.0.0.1:3000` on each host — launch image/metadata uploads proxy through backend-rs-sql (it owns the Filebase credentials); launch fails without it
- [ ] `skill.service` runs as user `skill` and binds `127.0.0.1:3010` only (`ss -ltnp | grep 3010` shows no public bind)
- [ ] `skill.seekuplift.com` site installed at `/etc/caddy/conf.d/skill.caddy` (backend Caddyfile with the `conf.d` import deployed first) with its own Origin CA cert; `X-Forwarded-For` replaced with `CF-Connecting-IP` (never appended)
- [ ] Cloudflare DNS: proxied CNAME `skill` → `app-api.seekuplift.com`; SSL mode Full (strict)
- [ ] `DONATION_CLAIM_AUTHORITIES` matches the app's production manifest — re-check on every config shipment
- [ ] Verify `/skill.md` and `/skill.json` are publicly reachable via `https://skill.seekuplift.com` (agent discovery)
