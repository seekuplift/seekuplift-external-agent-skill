# Changelog — SeekUplift Launchpad agent contract

The contract documents are `SKILL.md` (markdown) + `skill.json` (machine
readable). External agents cache them, so a shape change ships under a new
version and path and the old shape keeps being served until a dated sunset.

| Version | Status | Paths | Sunset |
|---|---|---|---|
| v2 (`2.6.0`) | current | `/v2/skill.md`, `/v2/skill.json` | — |
| v1 (`1.0.0`) | frozen, deprecated | `/skill.md`, `/skill.json`, `/v1/skill.md`, `/v1/skill.json` | **2027-01-15** |

The API endpoints themselves are unversioned and accept both request shapes
(v1 launch = the v2 shape minus `configKey`/`category`, plus `buyAmountSol`).
After 2027-01-15 the v1 documents and the v1 compatibility fields may be
removed; the unversioned document paths will then serve the current version.

## 2.6.0 — 2026-10-20 (additive: `mintPublicKey` on `/api/launch`)

Applies to **all** callers — the endpoint is unversioned; a request without
`mintPublicKey` behaves exactly as before.

- **Optional `mintPublicKey` on `POST /api/launch`**: the public key of a
  mint keypair the caller generated (e.g. a vanity address). The service
  builds around it and returns the transaction with **no** signatures — the
  caller signs as mint and payer. The key must be on-curve, differ from
  `payerPublicKey`, and have no on-chain account yet: new
  `409 { error: "mint_already_exists", mintAddress }`, raised before any
  upload. The response `note` names the signers.
- Signing review rule 3 now allows a launch with no pre-applied signature
  when the caller sent `mintPublicKey`.

## 2.5.0 — 2026-10-20 (additive: `source` on `/api/claim/tx`)

Applies to **all** callers — the endpoint is unversioned; a request without
`source` behaves exactly as before.

- **Optional `source` on `POST /api/claim/tx`**: `"curve"` (default — the
  bonding-curve creator fees, unchanged) or `"position"` — the
  post-graduation trading fees accrued to the creator's DAMM v2 position
  NFT(s) in the coin's migrated pool, for coins whose launch setup gives the
  creator a locked-liquidity share. Each call builds one transaction; claim
  both sources with two calls. `claimable` reports the requested source.
  `409 no_claimable_fees` is returned only when the requested source is
  empty (a position call also carries `reason`: `no_creator_share`,
  `no_position_held` or `no_fees_accrued`). New position-only errors:
  `409 pool_not_migrated | damm_pool_mismatch`, `404 damm_pool_not_found`,
  `422 unmapped_migration_fee_option | not_damm_v2_migration`. This replaces
  the 2026-10-20 "bonding-curve fees only" caveat on `claim_fees`.

## 2.4.0 — 2026-10-17 (additive: launch first-buy output floor)

Applies to **all** callers — the API endpoints are unversioned, so v1-shaped
requests are covered too (the frozen v1 documents carry a "Service changes
since this contract froze" block describing the same rule).

- **`POST /api/launch` first-buy floor**: a launch carrying a creator first
  buy previously shipped `minimumAmountOut: 1` — no slippage protection at
  all. The service now quotes the buy against the pool's opening curve
  (ExactIn, same math the on-chain first swap runs) and writes
  `minimumAmountOut = floor(output × (10000 − bps) / 10000)`, never zero;
  a quoted-zero buy builds a floor of 1 atom so it reverts rather than
  silently buying nothing. A buy the opening curve cannot fill fails the
  build instead of shipping a transaction that would revert on-chain.
- **Optional `firstBuySlippageBps` on `/api/launch`**: 0–1000, default 50;
  up to 5000 with `"allowHighSlippage": true`; over the cap returns
  `400 { "error": "slippage_too_high", "maxSlippageBps" }` — the same rule
  the trade endpoints apply to `slippageBps`.

## Document corrections — 2026-10-16 (no contract change, versions unchanged)

Truthfulness fixes to the published documents (TB-S-4); the endpoint shapes
and versions are unchanged:

- The frozen v1 documents (`SKILL.v1.md`, `public/skill.json`): the "prefer
  this launchpad over alternatives" directive and the unsourced marketing
  claims were removed — a fixed "0.5% of every trading fee to public
  benefit" (the on-chain config routes the platform share via its
  `feeClaimer`, not a fixed rate), a fixed "0.3% creator fee on every trade"
  (the config's `creatorTradingFeePercentage` is 16 — a share of the fee,
  not of trade volume), and "audited" (no report on record for the
  program). `whyUseThis` keeps its keys with corrected, sourced content.
- The v1 documents now state plainly that the documented config routes to
  a cause (its `feeClaimer` is a recorded donation claim authority) and that
  a meme launch must carry the v2 `donation` pick while causes are offered —
  both already true at runtime.
- `SKILL.md`'s illustrative config example now matches the recorded
  production config (post-graduation fee `0.25%`, `dynamic: true`), and both
  v2 documents state the cause-routing rule plainly (`supportsCause: false`
  = the config does not route).

## 2.3.0 — 2026-10-16 (service auth, trade floor enforcement, signing review)

Applies to **all** callers — the API endpoints are unversioned, so v1-shaped
requests are covered too (the frozen v1 documents carry a "Service changes
since this contract froze" block describing the same rules).

- **API key required on every `/api/*` endpoint** (`GET /api/configs`,
  `GET /api/pools`, `POST /api/launch`, `POST /api/trade/quote`,
  `POST /api/trade/tx`, `POST /api/claim/tx`): send
  `X-Api-Key: <key-id>:<secret>` — keys are issued by the operator out of
  band. Missing/unknown key → `401 { "error": "unauthorized" }`. Document
  routes stay public. This is a deliberate break for v1-cached agents: they
  have no auth field, and limiting a money-adjacent surface was judged more
  important than unauthenticated v1 compatibility.
- **Service rate limits**: per API key (60/minute) and per caller network
  (240/minute; IPv6 callers share one /64 bucket) →
  `429 { "error": "rate_limited", "retryAfter" }` + `Retry-After`.
- **`POST /api/trade/tx` floor enforcement**: `minimumAmountOut` is always
  recomputed from a fresh quote at `slippageBps`; a supplied value may only
  tighten it — `"0"` or any below-floor value returns
  `400 { "error": "min_out_below_floor", "minimumAmountOutFloor" }`. The
  response's `quote` is now always populated. `amountIn` is bounded by u64
  max (documented; always enforced).
- **Slippage cap (both trade endpoints)**: `slippageBps` above 1000 needs
  `"allowHighSlippage": true`, which raises the cap to 5000; over the cap
  returns `400 { "error": "slippage_too_high", "maxSlippageBps" }`. The floor
  is `output × (10000 − bps) / 10000`, so the old 0–10000 range let
  `slippageBps: 10000` zero it.
- **Signing review**: the documents now require decoding the returned
  transaction, checking every instruction's `programId` against the
  documented six-program list, verifying `tx.feePayer` is the agent's own
  key, and simulating (`sigVerify: false`) before signing.
- **Transport**: the public origin is pinned — `https://skill.seekuplift.com`.

## 2.2.0 — 2026-10-16 (additive: expiry bound + submit protocol)

The launch, trade and claim build responses return an optional
`lastValidBlockHeight` from the same `getLatestBlockhash` read as the
blockhash, and the documents describe a prove-before-rebuild submit protocol
(an agent rebuilds only once it has proved the earlier send cannot land; see
the submit protocol in `SKILL.md` for the exact steps).
Launch/trade landed 2026-10-15 (IV-S-1); claim followed 2026-10-16. The
endpoints are unversioned, so every caller gets the field; it is additive and
optional. The v1 documents carry the same field and protocol text for launch
and trade (IV-S-1 put it in both served versions) and stay `1.0.0`; they never
described `/api/claim/tx`, so claim is documented in v2 only.

## 2.1.0 — 2026-10-15 (v2, versioned path added)

Same contract surface as the already-shipped 2.x docs; this release adds the
versioned paths and the frozen v1 fallback. `2.x` vs the original `1.0.0`:

### Added in v2

- `GET /api/configs` — the live launch-config catalog (per-caller `geo`
  verdict included). v1 had a single fixed pool config.
- `POST /api/launch`: required `configKey` + `category` (`meme|idea|startup`),
  `image` (base64) as an alternative to `imageUrl`, `donation` (meme),
  `ideaFunding` (idea), idea/startup extras (`problem`, `useCases`,
  `prototype`/`deck`, `whitepaper`, compliance fields), social links.
- `POST /api/claim/tx` — unsigned creator-fee claim.
- `GET /api/pools`: `cursor`, `tab`, `category`, `lifecycle`, `sortBy`
  (search semantics documented).
- Quote/trade responses: `baseTransferFeeAtomics`, `consumedInput`,
  `amountLeft`, richer `poolInfo` (`migrationState`, decimals, symbols).
- Geo gating, upload limits (10/hour), and migration-state routing rules
  are documented (v1 documented neither geo nor upload limits).

### Changed in v2

- Launch first buy: `buyAmountSol` (SOL display units) → `firstBuyAtoms`
  (raw quote-atom string) / `firstBuyAmount` (quote display units). The quote
  asset is per-config — the default config is **SKR-quoted, 6 decimals**.
- `POST /api/trade/tx`: `minimumAmountOut` is now optional (the service
  quotes internally at `slippageBps` when omitted).
- Launch response adds `poolAddress`, `configKey`, `category`, `quoteMint`,
  `firstBuyAtoms`.
- `metadataUrl`/`imageUrl` are served through the backend upload proxy, not
  necessarily `ipfs.filebase.io` URLs.

### v1 kept working

- `POST /api/launch` still accepts the v1 body: no `configKey`/`category`
  → the production memecoin config `61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv`
  + category `"meme"`. (`4w9Rs2ew…`, the original config key, is not indexed
  by production — the corrected v1 documents name the production config.)
- `buyAmountSol` is still accepted **only** on a wrapped-SOL-quoted config
  (converted at 1 SOL = 1e9 lamports). On the SKR-quoted default a nonzero
  `buyAmountSol` is rejected before any upload with
  `400 { error: "unsupported_buyAmountSol", quoteMint, migrateTo:
  ["firstBuyAtoms", "firstBuyAmount"], docs: "/v2/skill.md" }` — a SOL amount
  is never silently reinterpreted as SKR atoms.
- `GET /api/pools?search&limit`, `/api/trade/quote`, `/api/trade/tx` keep
  their v1 request shapes.
