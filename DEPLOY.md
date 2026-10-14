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
| `BACKEND_URL` | Yes | backend-rs-sql base URL — the mobile-config source, pool listing, AND the IPFS upload proxy (`/api/upload/*`); the backend owns the Filebase credentials, this service holds none. Default: `http://localhost:3000`. In the colocated deployment the service calls it over loopback and forwards each caller's IP as `X-Forwarded-For` (the backend trusts XFF only from `127.0.0.1`), so geo verdicts and the 10/hour upload limit apply per calling agent. |
| `SOLANA_RPC_URL` | No | Solana mainnet RPC endpoint. Default: `https://api.mainnet-beta.solana.com` |
| `DONATION_CLAIM_AUTHORITIES` | No | Comma-separated donation claim authorities (config `feeClaimer` values that make a launch config cause-capable). Must mirror the app's `config/production-manifest.json` → `targets.production.donationClaimAuthorities` (`EXPO_PUBLIC_DONATION_CLAIM_AUTHORITY`); update it whenever the app's value changes or new configs ship. Unset/empty → no config is cause-capable. |

For production, use a private RPC (Helius, QuickNode, Triton) to avoid rate limits on `POST /api/launch` and `/api/trade/*` — those make multiple RPC calls per request.

---

## Vercel (recommended)

1. Push the repo to GitHub.

2. In [vercel.com](https://vercel.com), create a new project and point it at the repo. Set the **Root Directory** to `agent/`.

3. Add environment variables in **Project → Settings → Environment Variables**:
   - `SOLANA_RPC_URL` (use a private RPC)
   - `BACKEND_URL` (your deployed backend-rs-sql URL — required for launch + pool listing)
   - `DONATION_CLAIM_AUTHORITIES` (optional; enables cause-capable configs)

4. Deploy. Vercel auto-detects Next.js.

> The API routes use `runtime = 'nodejs'` and run as Vercel Serverless Functions. No edge runtime issues with Solana packages.

---

## Railway / Render / Fly.io (self-hosted)

These platforms run a Node.js process directly.

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

## Docker

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
docker build -t meteora-agent .
docker run -p 3001:3001 \
  -e SOLANA_RPC_URL=... \
  -e BACKEND_URL=... \
  meteora-agent
```

---

## Co-deploying with backend-rs-sql

If you run both services on the same host:

```
backend-rs-sql  → :3000
agent (Next.js) → :3001
```

Set `BACKEND_URL=http://localhost:3000` in `agent/.env.local`. The `/api/pools` route and the launch upload proxy (`/api/upload/image`, `/api/upload/metadata`) call it internally — no CORS configuration needed.

For Docker Compose:

```yaml
services:
  backend:
    build: ./backend-rs-sql
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://...

  agent:
    build: ./agent
    ports:
      - "3001:3001"
    environment:
      BACKEND_URL: http://backend:3000
      SOLANA_RPC_URL: ...
    depends_on:
      - backend
```

---

## Production Checklist

- [ ] Private Solana RPC set (`SOLANA_RPC_URL`) — public endpoint rate-limits aggressively
- [ ] `BACKEND_URL` set — launch image/metadata uploads proxy through backend-rs-sql (it owns the Filebase credentials); launch fails without it
- [ ] HTTPS in front of the service (Vercel/Railway handle this automatically)
- [ ] `BACKEND_URL` points to a running backend-rs-sql (pool listing, config catalog, and launch uploads all depend on it)
- [ ] Verify `/skill.md` and `/skill.json` are publicly reachable (agent discovery)
