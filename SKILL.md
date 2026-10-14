# Meteora Launchpad — Agent Skill

## Overview

Launch tokens and trade on **Meteora Dynamic Bonding Curve (DBC)** on Solana mainnet through the SeekUplift launchpad API.

Launch options are served as a live catalog of on-chain pool configs (`GET /api/configs`). Quote asset, fee schedule, creator share and cause routing differ per config — **the agent chooses a config per launch**. Nothing in this document hardcodes a config: always read the live catalog.

- **Network**: Solana mainnet-beta
- **DBC program**: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`
- **Base URL**: the same host that served this document
- **Machine-readable form**: `GET /skill.json`

## Prerequisites

- A funded Solana wallet keypair — the **payer** on launches, the **owner** on trades.
- ~0.02 SOL for rent + fees on launch, plus the config's `poolCreationFeeLamports` and any first buy. ~0.001 SOL+ for trades.
- On a config whose quote asset is not SOL (`quote.mint` ≠ `So1111…1112`), the payer/owner must hold that token.

## Flow at a glance

1. `GET /api/configs` → pick a config (see **Choosing a config**), check its `geo` verdict, read its full fee schedule to your user.
2. `POST /api/launch` → mint-partial-signed legacy transaction → add the payer signature → submit to mainnet.
3. `GET /api/pools` → find coins; a pool's `id` is the `poolAddress` the trade endpoints take.
4. `POST /api/trade/quote` → `POST /api/trade/tx` → unsigned legacy transaction → the owner signs → submit.

All responses are `cache-control: no-store`. Geo verdicts are per-caller — do not cache catalog responses across requests from different users.

---

## Choosing a config

Each `GET /api/configs` entry is one launch option. Pick by:

- **Memecoins**: use the entry marked `defaultFor: ["meme"]`. It is a creator-fee config (`fees.creatorSharePct > 0`) — never an all-fees-to-cause config. Switch to an `fees.allFeesToCause: true` config **only when the user explicitly asks** for every fee to go to the cause.
  - **No usable default?** If no config has `defaultFor: ["meme"]`, or it is geo-unavailable for the caller (`geo.byCategory.meme.allowed: false`), pick another meme-capable config with `fees.creatorSharePct > 0` (and `decodeError: null`, geo-allowed). **Never fall back to an `allFeesToCause` config** unless the user explicitly asked for all fees to go to the cause. If no such config exists, tell the user instead of launching.
- **Category**: the config must list your launch's `category` in `categories`. Pass it verbatim as `/api/launch`'s `category`.
- **`supportsCause`**: donation routing is available — a meme launch on such a config must include a `donation` pick while causes are offered.
- **`supportsFirstBuy`**: a creator first buy may be bundled into the launch transaction.
- **`isStock`**: the quote mint is a stock quote asset — `stock.create`/`stock.trade` geo keys apply.
- **`geo`**: the caller's create verdict (see **Geo** below). `geo.byCategory[category].allowed: false` means the launch will be refused for this caller.
- **`decodeError`**: non-null means the on-chain config could not be decoded; launching on it fails and its fee fields are conservative `custom`/`null` values — pick another config.

### Always explain the fee schedule first

**Before launching or trading, explain the chosen config's full fee schedule to your user.** Read the live figures from `GET /api/configs` (`fees.label`, `fees.details`, `fees.curve`, `fees.postGraduation`, `fees.creatorSharePct`) — never quote fee numbers from this document; they differ per config and can change when the backend's served options change.

Fee wording, consistent with the platform's fees page:

- Every trade pays the config's trading fee. **Meteora takes 20% of that fee first**; the remaining 80% splits between the creator, the platform partner share, and — on cause-capable configs — the picked project or cause.
- `fees.curve` is the on-curve schedule. When `curve.kind` is `"decay"` the fee **opens at `openingBps` — an anti-sniper opening fee** — and decays to `floorBps` over `decayPeriods × decayPeriodLength` `decayUnit` (`decaySecondsEstimate` is the approximate wall-clock window). Trades inside that window pay the elevated rate — warn the user before trading a fresh coin.
- `fees.postGraduation` is the schedule after the coin graduates to a DAMM pool (`"marketCapDecay"` decays toward `floorBps` as market cap grows).
- `fees.creatorSharePct` is the percent of trading fees routed to the creator share. On an `allFeesToCause` config it is 0 — every fee left after Meteora's protocol cut goes to the cause.
- `fees.curve.dynamic: true` means a volatility fee can add to the curve fee during sharp price moves.
- `poolCreationFeeLamports` is a one-time launch cost paid by the payer.
- `migrationQuoteThreshold` (raw quote atoms) is how much quote the curve must raise before the coin migrates.

Fee figures are in basis points (100 bps = 1%).

---

## Capabilities

### 1. `list_configs` — `GET /api/configs`

Returns the live launch catalog for THIS caller (geo verdict included, computed fresh).

**Response** — `{ "configs": [ … ] }`, each entry:

```json
{
  "configKey": "<base58 — pass verbatim as /api/launch's configKey>",
  "optionId": "<string | null>",
  "categories": ["meme"],
  "quote": {
    "mint": "<base58 | null>",
    "symbol": "SKR",
    "decimals": 6,
    "tokenProgram": "<base58 | null>",
    "issuer": "<string | null>",
    "firstBuyDefault": "<display-units string | null>",
    "scaledUiAmountMultiplier": "<decimal string | null>"
  },
  "fees": {
    "label": "99% → 1.25% (anti-sniper ~10 min), then 1.25% after graduation",
    "details": ["Bonding curve: starts at 99% base fee, decays to 1.25%", "…"],
    "curve": {
      "kind": "decay",
      "openingBps": 9900,
      "floorBps": 125,
      "decay": "time",
      "decayPeriods": 20,
      "decayPeriodLength": 75,
      "decayUnit": "slots",
      "decaySecondsEstimate": 600,
      "dynamic": false
    },
    "postGraduation": {
      "kind": "flat",
      "startBps": 125,
      "floorBps": 125,
      "decay": "none"
    },
    "creatorSharePct": 16,
    "allFeesToCause": false
  },
  "supportsCause": true,
  "supportsFirstBuy": true,
  "poolCreationFeeLamports": "0",
  "migrationQuoteThreshold": "<quote atoms, decimal string>",
  "isStock": false,
  "defaultFor": ["meme"],
  "geo": {
    "allowed": true,
    "reason": null,
    "region": "US",
    "byCategory": {
      "meme": { "allowed": true, "reason": null }
    }
  },
  "decodeError": null
}
```

> The fee values above are an illustrative example of the SHAPE — read live values, never copy them.

Field notes:

- `quote.scaledUiAmountMultiplier` is the Token-2022 ScaledUiAmount multiplier in effect now (decimal string, `null` when the mint has none). Display→atom conversion for this quote mint is `display × 10^decimals ÷ multiplier` — **never assume a fixed 1e9 or that the quote asset is SOL**.
- `geo.reason` is the first restricted feature key blocking the caller (e.g. `idea.create`, `cause.marketing`); `geo.region` is the caller's resolved region (may be `null`).

Errors: `502` upstream backend failure.

---

### 2. `launch_token` — `POST /api/launch`

Uploads image + metadata through the backend proxy and builds the launch transaction on the chosen config.

**Request** (JSON):

```json
{
  "configKey": "<from GET /api/configs — required>",
  "category": "meme",
  "name": "My Token",
  "symbol": "MTK",
  "description": "What this coin is for",
  "imageUrl": "https://example.com/logo.png",
  "payerPublicKey": "<base58 — signs + funds the launch; recorded as creatorAddress>",
  "donation": { "mode": "cause", "cause": "<cause slug>" },
  "firstBuyAtoms": "100000000",
  "website": "https://…",
  "twitter": "…",
  "telegram": "…",
  "discord": "…"
}
```

**Required**: `configKey`, `category` (`"meme"` | `"idea"` | `"startup"` — must be in the config's `categories`), `name`, `symbol`, `description`, `payerPublicKey`, and exactly one of `image` / `imageUrl`.

- `name`: ≥3 characters, ≤32 UTF-8 bytes. `symbol`: ≤10 UTF-8 bytes (leading `$`/whitespace stripped, uppercased). `description`: required, ≤2000 characters.
- `image`: base64 PNG/JPEG/GIF/WEBP, ≤10 MB; an RFC-2397 `data:<mime>;base64,…` URL is accepted when the declared type matches the bytes.
- `imageUrl`: a public `http(s)` URL fetched through an **SSRF guard** — no credentials in the URL, no `localhost`/`.local`/`.internal` hosts, private/loopback/link-local/CGNAT/documentation address targets refused (every DNS answer is vetted and the connection is pinned to it), redirects followed manually (≤3 hops, each re-vetted), 10 MB cap, magic-byte sniffed. `ipfs://` and other non-http(s) schemes are refused — pass a public gateway URL instead.
- `donation` — **meme launches only**, and only on `supportsCause` configs. `{ mode, cause?, project?, handle?, redditUserId? }`. **Required while the backend offers causes** — a `400` with `error: "donation_required"` lists `causesOffered` (slugs for `mode: "cause"`). Modes selectable at launch come from the backend's launch-enabled mode registry (typically `managed`, `cause`, `project`, `tbd`, `x`, `reddit`); `cause` takes `cause` (a shipping cause slug), `project` takes a bare positive Giveth project id in `project`, `x` takes `handle`, `reddit` takes `handle` + `redditUserId` (a `t2_` id), `managed`/`tbd` take no params.
- `ideaFunding` — **idea launches only**. `{ mode, address?, handle?, redditUserId? }`. Modes come from the backend's launch-enabled registry (`managed` and `realms` are never selectable; typically `direct`, `tbd`, `x`, `reddit`): `direct` takes `address` — an **on-curve** Solana address (no PDAs) that becomes the coin's entitled signer; `x` takes `handle`; `reddit` takes `handle` + `redditUserId`, or just `handle` and the service resolves the `t2_` id.
- **Idea extras** — required: `problem` (the use-case statement), `useCases` (1–3 slugs from the idea catalog: climate, education, inclusion, local, depin, desci, public-goods, infrastructure, payments, governance, social, art, gaming, defi, privacy, identity, health, energy, food, housing, mobility, other), `prototype` (URL). Optional: `whitepaper` (URI).
- **Startup extras** — required: `problem` (the pitch), `useCases` (1–3 slugs from the startup catalog: saas, consumer, fintech, ai, infrastructure, defi, payments, depin, gaming, rwa, social, data, creator, climate, education, health, security, wallet, marketplace, media, stablecoins, other), `deck` (URL). Optional: `whitepaper` (recorded as roadmap), plus the compliance fields `legalFramework`, `legalFrameworkNote`, `tokenUtility`, `decentralizationEfforts`, `entityJurisdiction` — recorded only when `startupComplianceAcknowledged: true`.
- `firstBuyAtoms` **or** `firstBuyAmount` — optional creator first buy, only on `supportsFirstBuy` configs. `firstBuyAtoms` is a bare integer string of raw **quote** atoms; `firstBuyAmount` is display units converted with the config's `quote.decimals` + `quote.scaledUiAmountMultiplier`. `0`/omitted = no first buy.

**Response**:

```json
{
  "transaction": "<base64 legacy Transaction — mint-signed, payer signature missing>",
  "mintAddress": "<base58 — the new token's mint>",
  "poolAddress": "<base58 — the DBC pool address /api/trade/* and /api/pools take>",
  "metadataUrl": "https://…",
  "imageUrl": "https://…",
  "configKey": "…",
  "category": "meme",
  "quoteMint": "<base58>",
  "firstBuyAtoms": "100000000",
  "note": "Deserialize from base64 as a legacy Transaction, sign with payerPublicKey, then submit to mainnet RPC. The mint keypair signature is already applied."
}
```

**Errors**: `400 { error }` validation (incl. `donation_required` with `causesOffered`); `403 { error: "geo_restricted", region, feature }`; `429` upload rate limit (see **Limits**); `502 { error: "upstream_error" }` upstream failure; `503 { error: "causes_unavailable" }` the cause list could not be loaded for a meme launch that needs a donation — retry later.

---

### 3. `trade_quote` — `POST /api/trade/quote`

Off-chain swap quote for a live curve pool.

**Request**:

```json
{
  "poolAddress": "<base58 — a pool's id from /api/pools or a launch response>",
  "side": "buy",
  "amountIn": "1000000",
  "slippageBps": 50
}
```

- `side`: `"buy"` (quote → base) or `"sell"` (base → quote).
- `amountIn`: base-10 integer atom **string**. Buy → **quote** atoms (lamports for SOL-quoted pools, `quoteDecimals` otherwise — check `poolInfo.quoteDecimals`/`quoteScaledUiAmount`, never assume 1e9). Sell → **base** atoms (`baseDecimals`).
- `slippageBps`: optional, 0–10000, default 50.

**Response**:

```json
{
  "amountOut": "<output atoms the wallet receives — net of any base transfer fee>",
  "minimumAmountOut": "<output floor at the request's slippage — pass verbatim to /api/trade/tx>",
  "baseTransferFeeAtomics": "<base-mint Token-2022 transfer fee implied, '0' when fee-free>",
  "consumedInput": "<gross input the curve actually consumed — < amountIn on a partial-fill buy>",
  "amountLeft": "<estimated gross refund on a partial-fill buy, else '0'>",
  "amountIn": "<echo of the request>",
  "slippageBps": 50,
  "poolInfo": {
    "poolAddress": "…", "configKey": "…",
    "baseMint": "…", "baseDecimals": 6,
    "quoteMint": "…", "quoteDecimals": 6,
    "quoteSymbol": "SKR",
    "quoteScaledUiAmount": null,
    "isQuoteSol": false,
    "baseTransferFee": false,
    "migrationState": "curve",
    "isCompleted": false
  }
}
```

- Buys use **partial-fill**: a buy that would push the pool past `migrationQuoteThreshold` consumes only enough quote to graduate the curve and refunds the rest — `consumedInput`/`amountLeft` report it. Sells always fill fully.
- `quoteScaledUiAmount`: `{ multiplier, newMultiplier, newMultiplierEffectiveTimestamp }` when the quote mint is a scaled Token-2022 mint — needed for display math on non-SOL quotes.
- `migrationState` / `isCompleted`: see **Migration states** below.

**Errors**: `400`, `403 geo_restricted`, `404 { error: "pool_not_found" }`, `409` (below), `5xx` upstream/RPC failure.

---

### 4. `trade_tx` — `POST /api/trade/tx`

Builds the unsigned swap transaction.

**Request**:

```json
{
  "poolAddress": "<base58>",
  "ownerPublicKey": "<base58 — signs + pays fees>",
  "side": "buy",
  "amountIn": "1000000",
  "minimumAmountOut": "<from /api/trade/quote — optional>",
  "slippageBps": 50
}
```

- `minimumAmountOut` of `"0"` **disables slippage protection** — agents should not send it. Pass the quote's value or omit the field.
- `minimumAmountOut` is taken **verbatim**. Omit it and the service quotes internally at `slippageBps` (default 50) — a one-call agent still gets the app's floor math, and the response's `quote` carries what was used.

**Response**:

```json
{
  "transaction": "<base64 legacy Transaction — unsigned; owner signs>",
  "amountIn": "…",
  "minimumAmountOut": "…",
  "quote": { "amountOut": "…", "minimumAmountOut": "…", "baseTransferFeeAtomics": "…", "consumedInput": "…", "amountLeft": "…", "amountIn": "…", "slippageBps": 50 },
  "poolInfo": { "…same as quote response…" }
}
```

`quote` is `null` when `minimumAmountOut` was supplied.

**Errors**: same set as the quote endpoint.

---

### 5. `list_pools` — `GET /api/pools`

Lists or searches coins launched on any catalog config.

```
GET /api/pools?search=<q>&limit=20&cursor=<cursor>&tab=emerging&category=meme&lifecycle=new&sortBy=createdAt
```

| Param | Values | Notes |
|---|---|---|
| `search` | name / symbol / mint | When present the call is a search — the list-only params are not forwarded to the backend (an invalid value still returns `400`) and `nextCursor` is always `null`. |
| `limit` | 1–100 | Default 20. |
| `cursor` | `nextCursor` from a previous list response | List only. |
| `tab` | `emerging` \| `graduated` | List only. |
| `category` | `meme` \| `idea` \| `startup` | List only. |
| `lifecycle` | `new` | List only. |
| `sortBy` | `createdAt` \| `createdAtAsc` \| `volume24h` \| `marketCap` | List only; `createdAt` is the default. |

**Response** — `{ "pools": [ … ], "nextCursor": "<string | null>" }`, each pool:

```json
{
  "id": "<DBC pool address — pass as poolAddress to /api/trade/*>",
  "name": "…", "symbol": "…", "baseMint": "…",
  "icon": "…", "description": "…",
  "launchType": "meme",
  "price": 0.0012, "nativePrice": 0.5,
  "quoteMint": "…", "quoteSymbol": "SKR",
  "priceChange24h": 3.4, "marketCap": 12345.6, "volume24h": 789.0,
  "graduated": false, "graduatedAt": null,
  "bondingCurve": 0.42,
  "configKey": "…",
  "createdAt": 1760000000000
}
```

`price`/`marketCap`/`volume24h`/`priceChange24h` are USD display figures, `nativePrice` is quote-denominated — display-grade only, never money-path inputs. `bondingCurve` is 0–1 progress toward migration.

**Errors**: `400 { error }` on an invalid `limit`/`tab`/`category`/`lifecycle`/`sortBy`; `502` upstream.

---

## Migration states — when not to trade on the curve

`poolInfo.migrationState` (and the `graduated` flag on pool listings) drives routing:

- `"curve"` — tradeable via `/api/trade/*`.
- `"migration_pending"` — the curve is finished but no graduated pool exists **yet**. `/api/trade/*` returns `409 { error: "pool_not_tradeable", migrationState: "migration_pending", retryable: true }`. **Retry later — do NOT route elsewhere**: no DAMM pool exists for Jupiter to route to either, and a curve swap would revert on-chain.
- `"migrated"` — terminal migration proven (`graduated: true` in listings). `/api/trade/*` returns `409 { migrationState: "migrated", retryable: false }`. **Trade the token on Jupiter.**
- A `409` with `reason: "quote_mint_transfer_fee_unsupported"` means the pool's quote mint carries a Token-2022 transfer fee the curve path cannot quote correctly — permanently unsupported, do not retry.
- `isCompleted` is the "curve unavailable" compatibility signal (`migrationState !== "curve"`); route on `migrationState`, not on it.

## Geo behavior — by the agent's IP, best effort

The service forwards the caller's IP to the backend, which resolves a fresh geo verdict **per request** (never cached). An unresolvable verdict fails open.

- **Launch (create) gating**: `idea` → `idea.create`; `startup` → `startup.create`; `meme` → `cause.marketing` plus a hidden key derived from the donation claim kind (`cause.specific_hidden` / `cause.managed_hidden`) — memecoin launches are effectively gated by cause availability; stock-quoted configs additionally → `stock.create` (checked only by this service). Refusal: `403 { error: "geo_restricted", region, feature }`, and — because the check runs **before** any upload — it costs no upload budget. Read `geo.byCategory` on the catalog entry first.
- **Trade gating**: idea/startup coins → `<category>.trade`; stock-quoted coins → `stock.trade`. **Memecoin trading is never geo-gated.**

## Limits

- **Uploads**: **10 per hour per caller IP**, shared by image + metadata uploads — one launch consumes 2. Exceeding it returns `429` from the backend. Validation and geo refusals happen before uploads, so they do not consume budget.
- Pool list/search calls share a per-IP read bucket on the backend.
- Image inputs: ≤10 MB, PNG/JPEG/GIF/WEBP (magic-byte sniffed, never the declared type).

## Transactions — signing and expiry

- All transactions are **legacy `Transaction`s** (not versioned): `Transaction.from(Buffer.from(b64, 'base64'))`.
- **Launch**: the server-generated mint keypair has **already partially signed**. Add only the payer signature — `tx.partialSign(payerKeypair)` — then `connection.sendRawTransaction(tx.serialize())`.
- **Trade**: the transaction is **unsigned** — `ownerPublicKey` signs and pays fees.
- The blockhash is fetched at build time — **sign and submit within ~90 seconds** or the transaction expires; rebuild instead of retrying a stale one.
- Submit to a Solana mainnet RPC (e.g. `https://api.mainnet-beta.solana.com`; a private RPC avoids rate limits).

## Error shapes

| Status | Body | Meaning |
|---|---|---|
| `400` | `{ error }` | Invalid request — message names the field. `error: "donation_required"` adds `causesOffered`; `unsupported_<field>` errors list `allowed`. |
| `403` | `{ error: "geo_restricted", region, feature }` | The caller's geo verdict blocks this launch or trade. |
| `404` | `{ error: "pool_not_found" }` | No DBC pool at that address. |
| `409` | `{ error: "pool_not_tradeable", migrationState, retryable }` | See **Migration states**. |
| `429` | backend body passthrough | Upload allowance exhausted. |
| `502`/`500` | `{ error: "upstream_error" }` | Upstream backend or Solana RPC failure — safe to retry. |
| `503` | `{ error: "causes_unavailable" }` | Cause list unavailable for a meme launch that needs a donation — retry later. |
