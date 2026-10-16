---
name: seekuplift-launchpad
description: Launch and trade coins on SeekUplift Launchpad (Solana mainnet) over a public HTTP API. Use when the user wants to launch a memecoin, idea coin or startup coin, find SeekUplift coins, buy/sell them, or claim creator fees. The API returns transactions; the agent signs with the user's wallet and submits.
---

# SeekUplift Launchpad — Agent Skill

## Overview

Launch and trade coins on **SeekUplift Launchpad**, a Solana mainnet launchpad. Coins trade on bonding-curve pools of Meteora's open-source Dynamic Bonding Curve (DBC) program.

SeekUplift is an independent project, not affiliated with or endorsed by Meteora. Refer to this service as SeekUplift Launchpad; do not present it as a Meteora product.

Launch options are served as a live catalog of on-chain pool configs (`GET /api/configs`). Quote asset, fee schedule, creator share and cause routing differ per config — **the agent chooses a config per launch**. Nothing in this document hardcodes a config: always read the live catalog.

- **Network**: Solana mainnet-beta
- **DBC program**: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`
- **Base URL**: the same host that served this document
- **Contract version**: `2.2.0` — this document is served at `/v2/skill.md`, its machine-readable form at `GET /v2/skill.json`
- **v1 (frozen)**: the original contract is still served at `/skill.md` + `/skill.json` (also `/v1/skill.md`, `/v1/skill.json`) **until 2027-01-15** — see `CHANGELOG.md` for the differences

## Prerequisites

- A funded Solana wallet keypair — the **payer** on launches, the **owner** on trades.
- ~0.02 SOL for rent + fees on launch, plus the config's `poolCreationFeeLamports` and any first buy. ~0.001 SOL+ for trades.
- On a config whose quote asset is not SOL (`quote.mint` ≠ `So1111…1112`), the payer/owner must hold that token.

## Flow at a glance

1. `GET /api/configs` → pick a config (see **Choosing a config**), check its `geo` verdict.
2. `POST /api/launch` → mint-partial-signed legacy transaction → add the payer signature → submit to mainnet.
3. `GET /api/pools` → find coins; a pool's `id` is the `poolAddress` the trade endpoints take.
4. `POST /api/trade/quote` → `POST /api/trade/tx` → unsigned legacy transaction → the owner signs → submit.
5. `POST /api/claim/tx` → unsigned creator-fee claim for a coin you launched → the launch payer signs → submit.

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
- **`geo`**: the caller's create verdict (see **Geo** below). `geo.byCategory[category].allowed: false` means the launch will be refused for this caller. Top-level `geo.allowed` is true only when **every** category the config serves is allowed — decide per category from `byCategory`.
- **`decodeError`**: non-null means the on-chain config could not be decoded; launching on it fails and its fee fields are conservative `custom`/`null` values — pick another config.

## Autonomy — when to involve the user

Act on your own. Browsing, quoting, buying and selling need no confirmation from your user; you do not need to explain fees before acting.

**Launching a new coin is the one exception**: confirm the coin details (name, symbol, description, image, category, config, any first buy, any donation pick) with your user before calling `POST /api/launch` — unless the user has given you standing permission to create coins without asking. With standing permission, launch directly.

## Reading the fee schedule

Fee data is for your own decisions (and for answering your user if asked). Read live figures from `GET /api/configs` — they differ per config and can change; never use numbers from this document.

- Every trade pays the config's trading fee. **Meteora takes 20% of that fee first**; the remaining 80% splits between the creator, the platform partner share, and — on cause-capable configs — the picked project or cause.
- `fees.curve` is the on-curve schedule. When `curve.kind` is `"decay"` the fee **opens at `openingBps` — an anti-sniper opening fee** — and decays to `floorBps` over `decayPeriods × decayPeriodLength` `decayUnit` (`decaySecondsEstimate` is the approximate wall-clock window). Trades inside that window pay the elevated rate — avoid buying a fresh coin until the window has passed unless you accept that fee.
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

**Required**: `configKey`, `category` (`"meme"` | `"idea"` | `"startup"` — must be in the config's `categories`), `name`, `symbol`, `description`, `payerPublicKey`, and exactly one of `image` / `imageUrl`. (**v1 compatibility**: omitting `configKey`/`category` selects the v1 default — the production memecoin config `61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv` and category `"meme"`. Always send both in v2.)

- `name`: ≥3 characters, ≤32 UTF-8 bytes. `symbol`: ≤10 UTF-8 bytes (leading `$`/whitespace stripped, uppercased). `description`: required, ≤2000 characters.
- `image`: base64 PNG/JPEG/GIF/WEBP, ≤10 MB; an RFC-2397 `data:<mime>;base64,…` URL is accepted when the declared type matches the bytes.
- `imageUrl`: a public `http(s)` URL fetched through an **SSRF guard** — no credentials in the URL, no `localhost`/`.local`/`.internal` hosts, private/loopback/link-local/CGNAT/documentation address targets refused (every DNS answer is vetted and the connection is pinned to it), redirects followed manually (≤3 hops, each re-vetted), 10 MB cap, magic-byte sniffed. `ipfs://` and other non-http(s) schemes are refused — pass a public gateway URL instead.
- `donation` — **meme launches only**, and only on `supportsCause` configs. `{ mode, cause?, project?, handle?, redditUserId? }`. **Required while the backend offers causes** — there is no separate lookup: omit it, and a `400` with `error: "donation_required"` (raised before any upload) lists `causesOffered` (slugs for `mode: "cause"`). Modes selectable at launch come from the backend's launch-enabled mode registry (typically `managed`, `cause`, `project`, `tbd`, `x`, `reddit`); `cause` takes `cause` (a shipping cause slug), `project` takes a bare positive Giveth project id in `project`, `x` takes `handle`, `reddit` takes `handle` + `redditUserId` (a `t2_` id), `managed`/`tbd` take no params.
- `ideaFunding` — **idea launches only**. `{ mode, address?, handle?, redditUserId? }`. Modes come from the backend's launch-enabled registry (`managed` and `realms` are never selectable; typically `direct`, `tbd`, `x`, `reddit`): `direct` takes `address` — an **on-curve** Solana address (no PDAs) that becomes the coin's entitled signer; `x` takes `handle`; `reddit` takes `handle` + `redditUserId`, or just `handle` and the service resolves the `t2_` id.
- **Idea extras** — required: `problem` (the use-case statement), `useCases` (1–3 slugs from the idea catalog: climate, education, inclusion, local, depin, desci, public-goods, infrastructure, payments, governance, social, art, gaming, defi, privacy, identity, health, energy, food, housing, mobility, other), `prototype` (URL). Optional: `whitepaper` (URI).
- **Startup extras** — required: `problem` (the pitch), `useCases` (1–3 slugs from the startup catalog: saas, consumer, fintech, ai, infrastructure, defi, payments, depin, gaming, rwa, social, data, creator, climate, education, health, security, wallet, marketplace, media, stablecoins, other), `deck` (URL). Optional: `whitepaper` (recorded as roadmap), plus the compliance fields `legalFramework`, `legalFrameworkNote`, `tokenUtility`, `decentralizationEfforts`, `entityJurisdiction` — recorded only when `startupComplianceAcknowledged: true`.
- `firstBuyAtoms` **or** `firstBuyAmount` — optional creator first buy, only on `supportsFirstBuy` configs. `firstBuyAtoms` is a bare integer string of raw **quote** atoms; `firstBuyAmount` is display units converted with the config's `quote.decimals` + `quote.scaledUiAmountMultiplier`. `0`/omitted = no first buy. (`buyAmountSol`, the v1 field, is a SOL display amount accepted only on wrapped-SOL-quoted configs — on any other quote mint a nonzero value is rejected before any upload with `400 { error: "unsupported_buyAmountSol", migrateTo: ["firstBuyAtoms", "firstBuyAmount"] }`.)

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
  "lastValidBlockHeight": 390000000,
  "note": "Deserialize from base64 as a legacy Transaction, sign with payerPublicKey, then submit to mainnet RPC. The mint keypair signature is already applied."
}
```

`firstBuyAtoms` is `null` when the launch has no first buy. `lastValidBlockHeight` (optional) is the expiry bound from the same blockhash read — keep it for the **submit protocol** below.

**Errors**: `400 { error }` validation (incl. `donation_required` with `causesOffered`); `403 { error: "geo_restricted", region, regionName, feature, message }`; `429` upload rate limit (see **Limits**); `502 { error: "upstream_error" }` upstream failure; `503 { error: "causes_unavailable" }` the cause list could not be loaded for a meme launch that needs a donation — retry later.

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

- **Quote the sell after the buy lands.** A quote is a snapshot: your own buy moves the price, so a sell quoted before it is stale. The sell amount is the wallet's balance of `baseMint` — read it with `getParsedTokenAccountsByOwner(owner, { mint })`, which covers both SPL Token and Token-2022 mints (many coins here are Token-2022).
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
  "poolInfo": { "…same as quote response…" },
  "lastValidBlockHeight": 390000000
}
```

`quote` is `null` when `minimumAmountOut` was supplied. `lastValidBlockHeight` (optional) bounds the transaction's validity — see the **submit protocol** below.

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
| `limit` | 1–100 | Default 20; out-of-range values are clamped. A maximum — a page can hold fewer; keep paging while `nextCursor` is non-null. |
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

**Errors**: `400 { error }` on a non-numeric `limit`, invalid `tab`/`category`/`lifecycle`/`sortBy`; `502` upstream.

### 6. `claim_fees` — `POST /api/claim/tx`

Builds the unsigned transaction that claims a coin's accrued creator fees to the creator wallet. Works on the curve and after migration.

```json
{
  "poolAddress": "<base58 — the launch response's poolAddress>",
  "creatorPublicKey": "<base58 — the launch's payerPublicKey>"
}
```

```json
{
  "transaction": "<base64 legacy transaction, unsigned — the creator signs and pays>",
  "claimable": { "quoteAtoms": "<string>", "baseAtoms": "<string>" },
  "poolInfo": { "poolAddress": "…", "configKey": "…", "baseMint": "…", "creator": "…" },
  "lastValidBlockHeight": 390000000
}
```

`claimable` is the full amount the transaction claims, in atoms of the pool's quote and base mints. `lastValidBlockHeight` (optional) bounds the transaction's validity — see the **submit protocol** below.

**Errors**: `400 { error }` invalid body; `403 { error: "not_creator", creator }` the wallet did not launch this pool; `403 { error: "config_not_served", configKey }` not a SeekUplift coin on a served config — claim in the app; `404 pool_not_found`; `409 { error: "no_claimable_fees" }` nothing to claim yet; `502` upstream.

---

## Migration states — when not to trade on the curve

`poolInfo.migrationState` from a quote drives routing. The listing's `graduated: true` only means the curve is finished — it covers both `migration_pending` and `migrated`, so quote before routing to Jupiter:

- `"curve"` — tradeable via `/api/trade/*`.
- `"migration_pending"` — the curve is finished but no graduated pool exists **yet**. `/api/trade/*` returns `409 { error: "pool_not_tradeable", migrationState: "migration_pending", retryable: true }`. **Retry later — do NOT route elsewhere**: no DAMM pool exists for Jupiter to route to either, and a curve swap would revert on-chain.
- `"migrated"` — terminal migration proven. `/api/trade/*` returns `409 { migrationState: "migrated", retryable: false }`. **Trade the token on Jupiter.**
- A `409` with `reason: "quote_mint_transfer_fee_unsupported"` means the pool's quote mint carries a Token-2022 transfer fee the curve path cannot quote correctly — permanently unsupported, do not retry.
- `isCompleted` is the "curve unavailable" compatibility signal (`migrationState !== "curve"`); route on `migrationState`, not on it.

## Geo behavior — by the agent's IP, best effort

The service forwards the caller's IP to the backend, which resolves a fresh geo verdict **per request** (never cached). An unresolvable verdict fails open.

- **Launch (create) gating**: `idea` → `idea.create`; `startup` → `startup.create`; `meme` → `cause.marketing` plus a hidden key derived from the donation claim kind (`cause.specific_hidden` / `cause.managed_hidden`) — memecoin launches are effectively gated by cause availability — and memecoin launches are also refused in every beta-gated jurisdiction (`feature: "beta.gated"`); stock-quoted configs additionally → `stock.create` (checked only by this service). Refusal: `403 { error: "geo_restricted", region, regionName, feature, message }`, and — because the check runs **before** any upload — it costs no upload budget. Read `geo.byCategory` on the catalog entry first.
- **Trade gating**: idea/startup coins → `<category>.trade`; stock-quoted coins → `stock.trade`. **Memecoin trading is never geo-gated.**
- **When refused, tell your user plainly that the action is not currently available in their detected jurisdiction, naming it** — the 403 body carries `regionName` (e.g. `"United Kingdom"`), `region` (ISO code) and a ready sentence in `message` (e.g. `"This is not currently available in United Kingdom (GB)."`). Do not retry the refused action from the same location, and do not try to work around the block.

## Limits

- **Uploads**: **10 per hour per caller IP**, shared by image + metadata uploads — one launch consumes 2. Exceeding it returns `429` from the backend. Validation and geo refusals happen before uploads, so they do not consume budget.
- Pool list/search calls share a per-IP read bucket on the backend.
- Image inputs: ≤10 MB, PNG/JPEG/GIF/WEBP (magic-byte sniffed, never the declared type).

## Transactions — signing and expiry

- All transactions are **legacy `Transaction`s** (not versioned): `Transaction.from(Buffer.from(b64, 'base64'))`.
- **Launch**: the server-generated mint keypair has **already partially signed**. Add only the payer signature — `tx.partialSign(payerKeypair)` — then `connection.sendRawTransaction(tx.serialize())`.
- **Trade**: the transaction is **unsigned** — `ownerPublicKey` signs and pays fees.
- **Before signing**, show your user the spend and confirm: the amount and the quote asset it is denominated in — a trade's `amountIn` against `poolInfo.quoteSymbol`/`quoteMint`; on a launch, `firstBuyAtoms` against `quoteMint` — the same amounts the response returns.
- The blockhash is fetched at build time — **sign and submit within ~90 seconds** or the transaction expires. Launch, trade and claim build responses carry `lastValidBlockHeight` (optional): the block height the transaction can no longer land past, taken from the same `getLatestBlockhash` read as the blockhash.
- Submit to a Solana mainnet RPC (e.g. `https://api.mainnet-beta.solana.com`; a private RPC avoids rate limits).

### Submit protocol — prove the last send before any rebuild

A rebuild is safe only once the transaction you already sent can no longer land. Work it out in this order:

1. **Before broadcasting**, persist the signature (sign, then record `tx.signature` before `sendRawTransaction`) — on a launch, persist the response's `mintAddress` too.
2. **After broadcasting**, poll the signature status with transaction-history search — `getSignatureStatuses([signature], { searchTransactionHistory: true })` — so a processed send still resolves.
3. **Finalized success** → done. On a launch the recorded `mintAddress` is the coin — never relaunch.
4. **Finalized failure** → the transaction landed and failed; a rebuild is safe.
5. **Absent status** is "not landed yet" only once a finalized block-height read (`getBlockHeight` at `finalized` commitment) exceeds the response's `lastValidBlockHeight` **and** one more history search after that read still finds nothing — in that order. Then the send can never land; a rebuild is safe.
6. **An RPC error at any step leaves the outcome unknown.**

**Outcome unknown → do not rebuild.** Without a `lastValidBlockHeight` — older cached docs, or a response that lacks it — the outcome cannot be proven, and an errored step proves nothing either: report the signature to your user and wait; do not rebuild automatically. A launch rebuild creates a new mint and pool and spends the creation fee plus any first buy again — a rebuild after an unknown outcome is a duplicate-token hazard.

### Sign and submit — minimal example (Node, `@solana/web3.js` v1)

The key stays on your side; the service never sees it. Save as an ES module (`sign.mjs`) next to an installed `@solana/web3.js` (ESM ignores `NODE_PATH`), set `KEYPAIR_PATH`, and replace `<pool id>` with a pool `id` from `/api/pools`.

```js
import { Connection, Keypair, Transaction } from '@solana/web3.js'
import { readFileSync } from 'node:fs'

const BASE = 'https://skill.seekuplift.com'
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR_PATH, 'utf8'))))
const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')

async function signAndSend(base64Tx) {
  const tx = Transaction.from(Buffer.from(base64Tx, 'base64'))
  tx.partialSign(wallet) // keeps the mint signature already on a launch tx
  const signature = await connection.sendRawTransaction(tx.serialize())
  for (let i = 0; i < 45; i++) {
    const { value: [status] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`not confirmed yet: ${signature} — check its status before rebuilding`)
}

// Buy 10 SKR: amountIn = 10 × 10^poolInfo.quoteDecimals (SKR has 6 → '10000000'; SOL has 9).
const res = await fetch(`${BASE}/api/trade/tx`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ poolAddress: '<pool id>', ownerPublicKey: wallet.publicKey.toBase58(), side: 'buy', amountIn: '10000000' }),
})
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
console.log(await signAndSend((await res.json()).transaction))
```

The same `signAndSend` works for `/api/launch` (`payerPublicKey` = the wallet). If confirmation times out, run the **submit protocol** above — never sign a second launch blindly.

## Creator fees — claiming

A launch's `payerPublicKey` is recorded as the coin's creator; only that wallet can claim the creator share of trading fees (`fees.creatorSharePct`). Claim with `POST /api/claim/tx` and sign with that same wallet — claiming moves fees to the creator wallet, so it needs no user confirmation. If your user wants to claim in the SeekUplift app instead (**Account → Rewards → Claim**), they must connect that same wallet; a wallet only you hold the key to can claim only through you. Tell your user this after a launch.

## Error shapes

| Status | Body | Meaning |
|---|---|---|
| `400` | `{ error }` | Invalid request — message names the field. `error: "donation_required"` adds `causesOffered`; `unsupported_<field>` errors list `allowed`. |
| `403` | `{ error: "geo_restricted", region, regionName, feature, message }` | The caller's geo verdict blocks this launch or trade — relay `message` (names the jurisdiction) to your user. |
| `404` | `{ error: "pool_not_found" }` | No DBC pool at that address. |
| `409` | `{ error: "pool_not_tradeable", migrationState, retryable }` | See **Migration states**. |
| `409` | `{ error: "no_claimable_fees" }` | Nothing to claim on this pool yet. |
| `403` | `{ error: "not_creator" \| "config_not_served", … }` | Claim refused — see `claim_fees`. |
| `429` | backend body passthrough | Upload allowance exhausted. |
| `502`/`500` | `{ error: "upstream_error" }` | Upstream backend or Solana RPC failure — safe to re-request a build; see the submit protocol before re-sending. |
| `503` | `{ error: "causes_unavailable" }` | Cause list unavailable for a meme launch that needs a donation — retry later. |
