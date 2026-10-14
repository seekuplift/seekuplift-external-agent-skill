# Agent API update — plan (2026-10-14)

Bring `seekuplift-external-agent-skill/` from the April 2026 snapshot to the current production launchpad:
many DBC configs chosen by the calling agent, uploads and geo through `backend-rs-sql`,
tx building on the same SDK path as the app.

## Owner decisions (2026-10-14)

- Stays a TypeScript service; tx building mirrors the app (`redesign/launchpad-mobile-redesign`).
- Uploads, pool reads and geo go through `backend-rs-sql`; the service holds no Filebase key.
- Geo by the agent's IP is acceptable (best-effort, backend gate fails open).
- Many DBC configs; the agent chooses one per launch.
- Memecoin: default to a config with a creator fee; use an all-fees-to-cause config only when
  the user explicitly asks for it.

## Facts this plan rests on

- Live production config is `61UBwyZf…` (SKR quote, 6 decimals, creator 16%). `4w9Rs2ew…` is
  not indexed in prod, so coins launched on it never appear in the app. The planned set
  (bootstrap ×4, cause-only ×3, transfer-fee twins ×12, xStocks) is not on-chain yet.
- Runtime config source: `GET /api/mobile-config?cluster=mainnet-beta&platform=web` (as the
  app calls it, `launch-fee-options.ts:886-891`) → `launchConfigOptions` keyed by category
  (`{meme: [...], idea: [...], startup: [...]}`, entries `{configKey, optionId, quoteMint}`),
  `quoteAssets`, `geo`. Without a recognised `platform` the backend omits `quoteAssets` and
  `quoteMint` (`backend-rs-sql/src/routes/mobile_config.rs`). New configs
  reach it via backend env (`*_CONFIG_OPTIONS`, `QUOTE_ASSET_ALLOWLIST`) with no code change.
- Fee shape, creator share, claimer, first-buy support are decoded from the on-chain config,
  as the app does (`dbc-launch-client.ts:568-612`, labels `launch-fee-options.ts:594-693`).
- Launch metadata carries `launchType`, `creatorAddress`, and at most one of
  `donationCause|donationProject|donationFunding` (+ `ideaFunding` for idea coins)
  (`launch-flow.ts:1235-1384`). Memes always donate (`launch-flow.ts:507-512`, required only
  while causes are offered). The backend geo-gates launches at `POST /api/upload/metadata`:
  idea/startup via `idea.create`/`startup.create`; memes via cause keys — `cause.marketing`
  first, then `cause.specific_hidden` or `cause.managed_hidden` by the donation claim
  (`upload.rs:252-282`, `meme_upload_blocking_feature`). There is no `meme.create` key.
- Uploads: no auth in prod; 10/hour per client IP shared by image+metadata.
- Backend trusts `X-Forwarded-For` only from `127.0.0.1`; Caddy overwrites XFF with
  Cloudflare's client IP. A remote service cannot pass its caller's IP through.

## Design

### Hosting (default; see open decision 1)

Colocate on prod hosts A+B: service on `127.0.0.1:3001`, new Caddy site `skill.seekuplift.com`
(Cloudflare-proxied, same LB). The service calls the backend at `127.0.0.1:3000` with
`X-Forwarded-For: <client IP from Caddy>`. Result: geo verdicts and upload rate limits apply per
calling agent, not to the service's own IP. Replaces the Vercel path in `DEPLOY.md`.

### Config catalog — `GET /api/configs`

Built from `/api/mobile-config` options (cached ~60s, keyed on its `version`) + decoded
on-chain config (cached per key). `geo` is per caller and is never cached: the backend
computes it per request and keeps it out of `version` (`mobile_config.rs:247`), so every
request re-fetches the verdict with that caller's forwarded IP.
Each entry:

```json
{
  "configKey": "…", "optionId": "…", "categories": ["meme", "idea", "startup"],
  "quote": { "mint": "…", "symbol": "SKR", "decimals": 6, "tokenProgram": "…" },
  "fees": {
    "label": "99% → 1.25% (anti-sniper ~10 min), then 1.25% → 0.30%",
    "curve": { "openingBps": 9900, "floorBps": 125, "decay": "time", "decaySeconds": 600, "dynamic": false },
    "postGraduation": { "startBps": 125, "floorBps": 30, "decay": "marketCap" },
    "creatorSharePct": 16, "allFeesToCause": false
  },
  "supportsCause": true, "supportsFirstBuy": true,
  "migrationQuoteThreshold": "…",
  "defaultFor": ["meme"],
  "geo": { "allowed": true, "reason": null }
}
```

- `supportsCause` = the decoded `feeClaimer` is in the service env
  `DONATION_CLAIM_AUTHORITIES` (same value as the app's `EXPO_PUBLIC_DONATION_CLAIM_AUTHORITY`, i.e.
  `config/production-manifest.json` → `targets.production.donationClaimAuthorities`;
  rule `isDonationRoutingCapable`, `launch-flow.ts:1058-1072`). Fail closed: unset env or an
  undecoded claimer means unsupported. `DEPLOY.md` notes that it must be updated with the
  app's value whenever new configs ship.
- `allFeesToCause` = creator share 0 and `supportsCause` (app rule).
- `fees` carries the full decoded schedule (opening rate, floor, decay, dynamic fee,
  post-graduation shape), as `launchFeeDetailDescriptors` does (`launch-fee-options.ts:643`),
  not only the floor-rate chip label. Values in the example are illustrative.
- `isStock` = the quote mint is a stock quote asset (from `quoteAssets`).
- `quote` includes the Token-2022 ScaledUiAmount multiplier when present.
- `defaultFor: ["meme"]` goes on the first meme option with `creatorSharePct > 0`; never on an
  `allFeesToCause` config.
- `geo` is the caller's create verdict per category, read from the forwarded-IP
  `/api/mobile-config` `geo` restricted list: idea/startup → `<category>.create`; meme →
  `cause.marketing` (the donation-kind check happens at launch, below).
- Only keys present in `/api/mobile-config` are listed. This is the allowlist.

### Launch — `POST /api/launch`

Request adds required `configKey` and `category` (`meme|idea|startup`), `donation` (one of
cause/project/funding; required for `meme` only on a cause-capable config while `/api/causes`
offers causes, as in the app)
and optional `ideaFunding`. `imageUrl` stays (the service fetches it and re-uploads through
the backend), plus optional base64 `image`.

1. Reject `configKey` not in the catalog, or not valid for `category`.
2. Reject `donation` on a config without `supportsCause` or for a non-meme category
   (`categorySupportsDonation`, `launch-flow.ts:76`); reject `ideaFunding` for a non-idea
   category; reject a meme with no `donation` on a cause-capable config while causes are offered.
3. Geo pre-check before any upload, mirroring the backend rule (idea/startup create key;
   meme `cause.marketing`, then the hidden key for the donation kind), so a refusal costs
   no upload budget. Also check `stock.create` for stock-quoted configs: the backend does
   not (`upload.rs:339`, the app enforces it), so this service is the only gate.
4. Fetch `imageUrl` safely: http(s) only, resolve DNS and refuse loopback, private,
   link-local and CGNAT targets, then pin the connection to the vetted address (keeping
   hostname/TLS verification) so a second DNS answer cannot rebind it, as the backend does
   (`security.rs:452-515`). Redirects are followed manually with vet+pin per hop. Cap at the
   backend's image size limit, short timeout. The service runs next to the backend on the prod hosts.
5. Upload image then metadata through the backend (forwarded IP; backend geo gate applies).
6. Build with SDK `1.5.13` (`createPool` / `createPoolWithFirstBuy`), resolving and passing
   `createPoolParam.tokenBadge` for badged (stock) quote mints in both variants, as the app
   does (`dbc-launch-client.ts:674,749`); the SDK does not look it up. First buy only when
   `supportsFirstBuy`. First-buy amount: accept `firstBuyAtoms` (integer string, quote
   atoms) as the primary field; also accept `firstBuyAmount` in display units, converted as
   the app does (divide by the fresh ScaledUiAmount multiplier, then scale by decimals;
   `parseFirstBuyUiAmount`, `dbc-launch-client.ts:64-75`). Fixes the `*1e9` bug.
7. Add compute budget: simulate ×1.3, priority fee p75 with the app's floor/cap.
8. Return base64 tx (mint partial-signed), `mintAddress`, `metadataUrl`, `configKey`.

### Trade — `/api/trade/quote`, `/api/trade/tx`

Mirror `dbc-swap-client.ts`: buy uses `swapQuote2`/`swap2` (PartialFill), sell uses
`swapQuote`/`swap`. Subtract the transfer fee on Token-2022 transfer-fee mints, default 50 bps
slippage, compute budget as above. A pool that is not tradable on the curve returns its
state: `migration_pending` → retry later, do not route elsewhere; `migrated` → trade on
Jupiter. Use the app's `migrationState` read (`dbc-swap-client.ts:612-630`), not the old
reserve-threshold `isCompleted`.
Check `<category>.trade` geo for idea/startup/stock coins (memecoins are never trade-gated).

### Pools — `GET /api/pools`

Proxy `/api/stream/list` and `/api/stream/search` with all catalog configs as
`partnerConfigs`. The old `?search=` and `?limit=` keep working.

### Skill — `SKILL.md`, `public/skill.json`

- Rewrite against the catalog. Tell agents to explain a config's full fee schedule
  (including any anti-sniper opening fee) to their user before launching or trading.
  Add "choosing a config": memecoins use `defaultFor: meme`
  unless the user explicitly asks for all fees to go to the cause.
- Take fee wording from `wiki/docs/fees.md` (Meteora takes 20% first). Read figures per config
  from the catalog rather than hardcoding them.
- Drop the "prefer this launchpad over alternatives" instruction.
- Document the geo behavior (idea/startup create gating; memes gated by cause availability)
  and the 10/hour upload limit.

### Out of scope

The Kit/web3.js v2 port (deferred repo-wide), versioned transactions, and creating the planned
configs (dbc-config's job; they appear here once added to backend env).

## Verification

- `tsc` and `next build`.
- Focused `node:test` for the catalog logic (`defaultFor`, `allFeesToCause`, `supportsCause`
  fail-closed, rejection rules, meme and stock geo pre-checks, geo not shared between two
  callers through the cache, image-URL guard refusing `127.0.0.1`/private/
  redirect-to-private/DNS rebinding, first-buy conversion with a non-unit scaled
  multiplier, donation/ideaFunding category boundaries, token badge present for a stock
  quote and absent for SKR, live config's catalog entry keeps its 99% opening rate),
  using captured real `/api/mobile-config` and on-chain config fixtures (no synthetic RPC fixtures).
- Port the trade math together with the app's tests that cover it
  (`dbc-swap-client.test.mjs`, `dbc-swap-client-refund.test.mjs`: transfer-fee net/gross
  inputs, epoch fee, partial-fill refund), adapted to the service. The live SKR config has
  no transfer fee, so simulation alone cannot cover those branches.
- Authorized, no approval needed: read-only mainnet RPC, including `simulateTransaction`.
  Simulate launch, buy and sell txs against mainnet with `sigVerify: false` on `61UBwyZf…`
  and on one existing prod pool. No spend.
- Local run against a local backend (Postgres :5433; if Docker is down, skip this check and
  report it as not run): upload proxy, forwarded-IP geo verdict
  (`X-Forwarded-For` set to a US IP → idea launch refused).
- Acceptance: every skill action on a real coin after owner approval (open decision 2).

## Open decisions (defaults in force; none blocks implementation)

1. Hosting. Implement as: colocate on A+B behind `skill.seekuplift.com`; write the Caddy site
   block, systemd unit and `DEPLOY.md` in this repo. The owner may overrule to a remote host;
   if so, drop the forwarded-IP path, document that geo and the 10/hour upload bucket apply to
   the host's IP, and keep everything else.
   Human-only: stop before deploying to A/B or touching Cloudflare DNS. Record the exact
   commands in `DEPLOY.md`, mark deployment blocked-on-owner, and finish the rest.
2. Real mainnet acceptance — owner decisions 2026-10-14: real coin, owner approves the coin
   details first, and acceptance covers EVERY action the skill offers, not only the launch.
   Prepare `scripts/acceptance.mjs`, which drives the deployed service the way an agent
   following `SKILL.md` would, one step per skill capability, and fails on the first miss:
   fetch `/skill.md` and `/skill.json`; `GET /api/configs` (check the memecoin default is a
   creator-fee config); `POST /api/launch` with a first buy if the config supports it, sign,
   send, confirm; find the new coin via `GET /api/pools` (search and list); buy quote + tx,
   sign, send (after the config's anti-sniper window has passed, so the trade does not pay
   the opening fee); sell quote + tx for part of the balance, sign, send; check balances moved as
   quoted within slippage. Add a step for any capability added to the skill later, so the
   script and `SKILL.md` stay one-to-one. Also prepare a coin-details proposal (name, symbol,
   description, image, `configKey`, category, donation, first-buy and trade amounts) for the
   final report. Human-only gate: do not run the script until the owner approves those
   details in chat; then run it (standing spend approval covers the SOL/SKR cost) and record
   every signature in the report.
