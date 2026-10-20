# Changelog — SeekUplift Launchpad agent contract

The contract documents are `SKILL.md` (markdown, `/skill.md`) and `skill.json`
(machine readable, `/skill.json`). External agents cache them, so a shape
change after release ships under a new version.

## 1.0.0 — unreleased

The first release of the contract. Nothing has shipped yet, so this entry is
the whole history; it is rewritten freely until the first release.

- **Auth**: `X-Api-Key: <key-id>:<secret>` on every `/api/*` call; the
  document routes stay public. Missing/unknown key → `401 { "error":
  "unauthorized" }`; per-key and per-caller limits → `429 rate_limited`.
- **Config catalog**: `GET /api/configs` lists the live launch options for
  the caller (fees, quote asset, categories, geo verdict). `POST /api/launch`
  requires `configKey` and `category`.
- **Launch**: `POST /api/launch` builds a mint-partial-signed legacy
  transaction. Optional creator first buy (`firstBuyAtoms` /
  `firstBuyAmount`, quoted floor via `firstBuySlippageBps`), optional
  caller-held mint (`mintPublicKey`, on-curve, no existing account, `409
  mint_already_exists`; the caller then signs as mint and payer), and the
  idea / startup / donation fields.
- **Trade**: `POST /api/trade/quote` then `POST /api/trade/tx` (unsigned
  transaction; `minimumAmountOut` may only tighten the service-computed
  floor).
- **Pools**: `GET /api/pools` with search, tab, category, lifecycle and sort
  parameters.
- **Claim**: `POST /api/claim/tx` claims creator fees; `source` is `"curve"`
  (default, bonding-curve creator fees) or `"position"` (post-graduation
  DAMM v2 position fees where the coin's launch setup gives the creator a
  share).
- **Submit protocol**: transactions expire (`lastValidBlockHeight`); the
  signing review rules and the prove-before-rebuild protocol are in
  `SKILL.md`.
