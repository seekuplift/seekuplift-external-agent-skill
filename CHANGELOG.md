# Changelog — SeekUplift Launchpad agent contract

The contract documents are `SKILL.md` (markdown) + `skill.json` (machine
readable). External agents cache them, so a shape change ships under a new
version and path and the old shape keeps being served until a dated sunset.

| Version | Status | Paths | Sunset |
|---|---|---|---|
| v2 (`2.1.0`) | current | `/v2/skill.md`, `/v2/skill.json` | — |
| v1 (`1.0.0`) | frozen, deprecated | `/skill.md`, `/skill.json`, `/v1/skill.md`, `/v1/skill.json` | **2027-01-15** |

The API endpoints themselves are unversioned and accept both request shapes
(v1 launch = the v2 shape minus `configKey`/`category`, plus `buyAmountSol`).
After 2027-01-15 the v1 documents and the v1 compatibility fields may be
removed; the unversioned document paths will then serve the current version.

## 2026-10-16 — `lastValidBlockHeight` on claim (additive, v2 docs only)

`POST /api/claim/tx` now returns the optional `lastValidBlockHeight` (from the
same `getLatestBlockhash` read as the blockhash), like the launch and trade
build responses (IV-S-1). Documented in `SKILL.md` / `/v2/skill.json` only:
the frozen v1 documents never described `/api/claim/tx` (it is a v2 addition),
so their shape is unchanged. The endpoint is unversioned, so any caller gets
the extra field; it is additive and optional.

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
