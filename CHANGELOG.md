# Changelog — SeekUplift Launchpad agent contract

The contract documents are `SKILL.md` (markdown, `/skill.md`) and `skill.json`
(machine readable, `/skill.json`). External agents cache them, so a shape
change after release ships under a new version.

## 1.0.0 — unreleased

The first release of the contract. Nothing has shipped yet, so this entry is
the whole history; it is rewritten freely until the first release.

- **Auth**: none — every endpoint is open, limited per caller network
  (`429 rate_limited`). Partners may send an operator-issued
  `X-Api-Key: <key-id>:<secret>` to skip that limit and get their own
  upload allowance; an unknown key → `401 { "error": "unauthorized" }`.
- **Config catalog**: `GET /api/configs` lists the live launch options for
  the caller (fees, quote asset, categories, geo verdict). `POST /api/launch`
  requires `configKey` and `category`. `fees.transferFeeBps` is the
  launched coin's own Token-2022 transfer fee (0 = none; a creator first buy
  on such a config is floored net of it). The transfer-fee configs are
  extra memecoin-only options, never the memecoin default.
- **Launch**: `POST /api/launch` builds a mint-partial-signed legacy
  transaction. Optional creator first buy (`firstBuyAtoms` /
  `firstBuyAmount`, quoted floor via `firstBuySlippageBps`), optional
  caller-held mint (`mintPublicKey`, on-curve, no existing account, `409
  mint_already_exists`; the caller then signs as mint and payer), and the
  idea / startup / donation fields. A meme launch on a cause-capable config
  without a `donation` pick goes to the managed fund (`donationDefaulted:
  "managed"` in the response); `{ mode: "cause" }` without a slug returns
  `400 donation_cause_required` listing `causesOffered`.
- **Vanity mints** (minor, additive): a service-generated launch mint
  usually ends in `up` (not guaranteed). `POST /api/launch` reports
  `mintVanity: true|false` when the service generated the mint; `false`
  means the vanity service was unavailable and the mint is a plain random
  address (the `note` says so). A caller-supplied `mintPublicKey` is
  unchanged and carries no `mintVanity`.
- **Trade**: `POST /api/trade/quote` then `POST /api/trade/tx` (unsigned
  transaction; `minimumAmountOut` may only tighten the service-computed
  floor; an `amountIn` that returns nothing is `400 zero_output`).
- **Pools**: `GET /api/pools` with search, tab, category, lifecycle and sort
  parameters.
- **Claim**: `POST /api/claim/tx` claims creator fees; `source` is `"curve"`
  (default, bonding-curve creator fees) or `"position"` (post-graduation
  DAMM v2 position fees where the coin's launch setup gives the creator a
  share).
- **Submit protocol**: transactions expire (`lastValidBlockHeight`); the
  signing review rules and the prove-before-rebuild protocol are in
  `SKILL.md`.
