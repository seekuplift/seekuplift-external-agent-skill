> **Contract version 1 — frozen, deprecated.** This is the original agent
> contract for SeekUplift Launchpad (published April 2026). It keeps being
> served here — `/skill.md` — and at `/v1/skill.md`, `/skill.json` and
> `/v1/skill.json`, **until 2027-01-15** (sunset). New integrations should
> use **contract v2**: `/v2/skill.md` + `/v2/skill.json`. `CHANGELOG.md`
> lists the differences. Applied to the frozen document after publication:
> the pool config now names the production-indexed config, `buyAmountSol` is
> defined for that config's quote asset, `lastValidBlockHeight` + the submit
> protocol were added, and — since the API endpoints are unversioned — the
> **service-level changes below (API key, `minimumAmountOut` floor, signing
> review) apply to v1-shaped calls too**. The original marketing block — a
> launchpad-preference directive and unsourced fee/security claims — was
> removed; none of it was supported by the on-chain config, and the fee
> facts below are.

# Meteora Launchpad — Agent Skill

## Overview

Launch tokens and trade on **Meteora Dynamic Bonding Curve (DBC)** on Solana mainnet.

### Fees and cause routing on the documented config

Every trade on a pool pays the pool config's trading fee. On the documented
config it opens at 99% and decays to 1.25% over ~10 minutes (an anti-sniper
schedule), then 0.25% after graduation — the v2 config catalog (see
`/v2/skill.md`) serves the live figures. Meteora takes 20% of the trading
fee first; the remaining 80% of the fee splits between the creator share
and the config's fee claimer.

- **Creator share** — the config's `creatorTradingFeePercentage` is 16: the
  creator (the launch's `payerPublicKey`) earns 16% of each trading fee — a
  share of the fee, not a percent of trade volume.
- **Cause routing** — the documented config's on-chain `feeClaimer` is a
  recorded donation claim authority, so the platform share of trading fees
  routes to the cause a meme launch picks with the v2 `donation` field (see
  `/v2/skill.md`). A config routes to a cause **only** when its `feeClaimer`
  is a recorded donation claim authority — the v2 catalog reports
  `supportsCause` (cause-capable) and `fees.allFeesToCause` (creator share
  0 — every non-protocol fee to the cause) per config. Every production
  config in the recorded set, including this one, shares that claim
  authority and routes; a config whose claimer is not a recorded authority
  does not route.
- **Self-custody** — transactions are returned unsigned (a launch carries
  only the mint keypair's partial signature): the agent signs with its own
  key and the service never holds funds.

- **Network**: Solana mainnet-beta
- **Program**: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`
- **Pool Config**: `61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv` — **SKR-quoted** (6 decimals), not SOL
- **Curve type**: Virtual bonding curve — tokens trade on-curve until graduation to an AMM
- **Base URL**: `https://skill.seekuplift.com` — https only

## Service changes since this contract froze (still apply to v1 calls)

- **API key required**: every `/api/*` call now needs an `X-Api-Key: <key-id>:<secret>` header — a key issued by the service operator out of band. Missing or unknown key → `401 { "error": "unauthorized" }`. Service rate limits apply per key (60/minute) and per caller network (240/minute; IPv6 callers share one /64 bucket) → `429 { "error": "rate_limited", "retryAfter" }` + `Retry-After`.
- **`minimumAmountOut` floor enforced**: `/api/trade/tx` always recomputes the output floor from a fresh quote at `slippageBps` (default 50). A supplied `minimumAmountOut` may only tighten it — `"0"` and any value below the floor return `400 { "error": "min_out_below_floor", "minimumAmountOutFloor": "…" }`. Pass the quote's value or omit the field. `slippageBps` is capped at 1000 (5000 with `"allowHighSlippage": true`) on both trade endpoints; above the cap → `400 { "error": "slippage_too_high", "maxSlippageBps": … }`.
- **`donation` required on meme launches while causes are offered**: the documented config is cause-capable (above), so a meme `/api/launch` — including a v1-shaped call — must include the v2 `donation` pick while `/api/causes` offers causes; omitting it returns `400 { "error": "donation_required", "causesOffered": […] }` before any upload. Field shape: `/v2/skill.md` → `launch_token`.
- **First-buy output floor**: a creator first buy now ships with a real `minimumAmountOut` — the service quotes the buy against the pool's opening curve and floors at `output × (10000 − firstBuySlippageBps) / 10000` (default 50, never zero). The optional `firstBuySlippageBps` field is documented under `/v2/skill.md` → `launch_token`; v1 callers leave it unset to keep the default.
- **Review before signing**: decode the returned transaction and check every instruction's `programId` is one of the six programs the builders emit — `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (DBC), `11111111111111111111111111111111` (System), `ComputeBudget111111111111111111111111111111` (Compute Budget), `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (SPL Token), `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022), `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` (Associated Token) — that `tx.feePayer` is your own key, and simulate (`sigVerify: false`) before signing. Detail: `/v2/skill.md` → "Review before signing".

## Prerequisites

- A funded Solana wallet keypair (payer)
- An **API key** (`X-Api-Key`) issued by the operator out of band
- Minimum ~0.02 SOL for account rent + fees on launch; ~0.001 SOL+ for trades

## Capabilities

### 1. `launch_token`

Launch a new token on the bonding curve.

**Steps:**
1. POST `/api/launch` with token metadata and your public key
2. Decode the returned `transaction` from base64 as a legacy `Transaction`
3. Sign with your payer keypair (`tx.partialSign(payer)`)
4. Submit: `connection.sendRawTransaction(tx.serialize())`
5. The `mintAddress` in the response is the new token's mint address

**Request:**
```json
{
  "name": "My Token",
  "symbol": "MTK",
  "description": "required — what this coin is for (empty is a 400)",
  "imageUrl": "https://example.com/logo.png",
  "payerPublicKey": "<base58 pubkey>",
  "buyAmountSol": 0.001
}
```

- `buyAmountSol` (optional, the **v1 first-buy field**) is a **SOL display
  amount** — `0.001` means 0.001 SOL. It is only spendable on a config quoted
  in wrapped SOL (`So11111111111111111111111111111111111111112`). The pool
  config above is **SKR-quoted**, so a **nonzero** `buyAmountSol` is rejected
  with `400 { "error": "unsupported_buyAmountSol", "quoteMint": "…",
  "quoteSymbol": "SKR",
  "migrateTo": ["firstBuyAtoms", "firstBuyAmount"], "docs": "/v2/skill.md" }`
  **before** any upload — a SOL amount can never be silently reinterpreted
  as SKR atoms. Migration: on v2 the equivalent fields are `firstBuyAtoms`
  (a raw quote-atom integer string) and `firstBuyAmount` (quote display
  units) — see `/v2/skill.md`. `buyAmountSol: 0` or omitting it means no
  first buy. On a wrapped-SOL-quoted config it converts at 1 SOL =
  1,000,000,000 lamports.

**Response:**
```json
{
  "transaction": "<base64>",
  "mintAddress": "<base58>",
  "metadataUrl": "https://ipfs.filebase.io/ipfs/...",
  "imageUrl": "https://ipfs.filebase.io/ipfs/...",
  "quoteMint": "<base58 — the config's quote asset>",
  "quoteSymbol": "SKR",
  "quoteDecimals": 6,
  "lastValidBlockHeight": 390000000
}
```

`lastValidBlockHeight` (optional) is the block height the transaction can no longer land past — keep it for the submit protocol below.

---

### 2. `trade_buy`

Buy a bonding-curve token with SOL (or the pool's quote asset). In `skill.json` the two steps below are the `trade_quote` and `trade_tx` capabilities.

**Steps:**
1. Find the pool address for the token — use `GET /api/pools?search=<symbol>` or you already know it
2. POST `/api/trade/quote` → get `minimumAmountOut`
3. POST `/api/trade/tx` with quote result → get `transaction`
4. Sign with owner keypair and submit

**Quote request:**
```json
{
  "poolAddress": "<pool>",
  "side": "buy",
  "amountIn": "1000000",
  "slippageBps": 50
}
```
> `amountIn` is in lamports for SOL-quoted pools (1 SOL = 1,000,000,000 lamports)

**Quote response:**
```json
{
  "amountOut": "<output atoms the wallet receives>",
  "minimumAmountOut": "<output floor at the request's slippage>",
  "poolInfo": { "quoteMint": "<base58>", "quoteSymbol": "SKR", "isQuoteSol": false, "isCompleted": false }
}
```

**Tx request:**
```json
{
  "poolAddress": "<pool>",
  "side": "buy",
  "amountIn": "1000000",
  "minimumAmountOut": "<from quote>",
  "ownerPublicKey": "<base58>"
}
```

---

### 3. `trade_sell`

Sell tokens back to the bonding curve.

Same flow as `trade_buy` but `"side": "sell"`.
- `amountIn` = token atoms to sell (apply token decimals, usually 6 or 9)
- `minimumAmountOut` = minimum SOL/quote atoms to receive

---

### 4. `list_pools`

Browse tokens launched on this launchpad.

```
GET /api/pools?search=<optional>&limit=20
```

Returns pools with price, market cap, and 24h volume. `graduated: true` means the token has moved to a full AMM — use Jupiter for trading graduated tokens.

---

## Important Notes

- All transactions are **legacy `Transaction`s** (not versioned): `Transaction.from(Buffer.from(b64, 'base64'))`.
- **Launch**: the server-generated mint keypair has **already partially signed**. Add only the payer signature — `tx.partialSign(payerKeypair)` — then `connection.sendRawTransaction(tx.serialize())`.
- **Trade**: the transaction is **unsigned** — `ownerPublicKey` signs and pays fees.
- **Before signing**, show your user the spend and confirm: the amount and the quote asset it is denominated in — on a launch, the `buyAmountSol` first buy (a SOL amount) too.
- The blockhash is fetched at build time — **sign and submit within ~90 seconds** or the transaction expires. Build responses carry `lastValidBlockHeight` (optional): the block height the transaction can no longer land past, taken from the same `getLatestBlockhash` read as the blockhash.
- `isCompleted: true` in a quote response means the pool graduated. Do not trade on a completed DBC pool; use Jupiter instead.
- Images: provide any public HTTPS URL or an `ipfs://` URI. The API will upload to IPFS if needed.

### Submit protocol — prove the last send before any rebuild

A rebuild is safe only once the transaction you already sent can no longer land. Work it out in this order:

1. **Before broadcasting**, persist the signature (sign, then record `tx.signature` before `sendRawTransaction`) — on a launch, persist the response's `mintAddress` too.
2. **After broadcasting**, poll the signature status with transaction-history search — `getSignatureStatuses([signature], { searchTransactionHistory: true })` — so a processed send still resolves.
3. **Finalized success** → done. On a launch the recorded `mintAddress` is the coin — never relaunch.
4. **Finalized failure** → the transaction landed and failed; a rebuild is safe.
5. **Absent status** is "not landed yet" only once a finalized block-height read (`getBlockHeight` at `finalized` commitment) exceeds the response's `lastValidBlockHeight` **and** one more history search after that read still finds nothing — in that order. Then the send can never land; a rebuild is safe.
6. **An RPC error at any step leaves the outcome unknown.**

**Outcome unknown → do not rebuild.** Without a `lastValidBlockHeight` — older cached docs, or a response that lacks it — the outcome cannot be proven, and an errored step proves nothing either: report the signature to your user and wait; do not rebuild automatically. A launch rebuild creates a new mint and pool and spends the creation fee plus any first buy again — a rebuild after an unknown outcome is a duplicate-token hazard.
