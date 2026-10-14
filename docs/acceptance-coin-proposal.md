# Acceptance coin proposal — ticket 09

Proposed real coin for the real-coin acceptance run of every skill action
(`scripts/acceptance.mjs`). **Blocked on owner approval** — the script refuses
`--send` until an approval file carries the `planHash` of the full resolved run
plan (below), and unless the base URL is `https://skill.seekuplift.com`
(ticket 08's deployment; `ACCEPTANCE_ALLOW_LOCAL_SEND=yes` is the only
override). No transaction has been or will be sent before that.

Values below were read from the **live catalog** (`GET /api/configs` on
2026-10-14, backend `http://localhost:3033` serving the production
`mobile-config`) and are re-read by the script at run time — nothing is
hardcoded per config.

## Coin details

| Field | Value | Notes |
|---|---|---|
| `name` | `Skill Acceptance Coin` | Brand-neutral on purpose: the backend refuses names echoing the platform brand (`422 brand_impersonation`) — the dry-run caught this with an earlier "SeekUplift …" name. |
| `symbol` | `SKACC` | ≤10 bytes, no `$` prefix needed (service strips/uppercases). |
| `description` | `Real-coin acceptance launch for the Meteora launchpad agent skill: one creator-fee memecoin launched, found, bought and sold end-to-end by scripts/acceptance.mjs after owner approval.` | Says exactly what the coin is. |
| `image` | generated 256×256 PNG (dark field, teal ring + diamond mark), produced in-script — override with `ACCEPTANCE_IMAGE=<png>` if the owner prefers other art | Uploaded through the backend proxy like any launch image. |
| `category` | `meme` | |
| `configKey` | `61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv` | The live `defaultFor:["meme"]` catalog entry — the same config production coins launch on, so the coin appears in the app's pool lists. |
| `quote` | SKR (`SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`), 6 decimals, SPL Token, no ScaledUiAmount multiplier | Payer needs SKR for the first buy and the buy step. |
| `fees` | label `99% → 1.25% (anti-sniper ~10 min), then 0.25% after graduation`; curve `decay`: opening 9900 bps → floor 125 bps over 20×75 slots (`decaySecondsEstimate` ≈ 600 s); `creatorSharePct` 16; `allFeesToCause` false | The creator-fee default the skill mandates for memecoins. Trades wait out the ~600 s window (+60 s margin) so they pay the floor fee, not the opening fee. |
| `supportsFirstBuy` / `supportsCause` | `true` / `true` | First buy bundled; donation required only while shipping causes are offered. |
| `donation` | `{ "mode": "cause", "cause": "<causesOffered[0]>" }` when causes are offered, else none | Resolved **before approval** and printed in the plan (and hashed): the dry-run POSTs without a donation and takes the first offered slug on `400 donation_required` (pin one with `ACCEPTANCE_DONATION_CAUSE`). `--send` never re-picks; if the offered causes change, the plan hash changes and needs re-approval. On the earlier dry-run backend no shipping cause was offered (donation none). **The owner must confirm the cause printed in the plan.** |
| `firstBuyAmount` | `100` SKR (display units — the config's `quote.firstBuyDefault`; service converts to atoms) | ≈ the suggested creator position. |
| buy amount | `10` SKR = `10000000` quote atoms (`ACCEPTANCE_BUY_AMOUNT`) | Small; inside the migration threshold by far. |
| sell amount | 50% of the purchased base balance (`ACCEPTANCE_SELL_BPS=5000`) | "Part of the balance" per the ticket. |
| `slippageBps` | `100` | 1% — small trade on a fresh curve. |
| payer | funded owner keypair from `ACCEPTANCE_KEYPAIR` (part of the plan) | Pre-checked before anything is sent; the script refuses if short. Needs the config's pool-creation fee + 0.03 SOL margin for rent/fees, and ~111.1 SKR (100 first buy + 10 buy, +1% margin). |

## Run plan (once owner approves + service is deployed)

The approval binds the **whole plan**, not just name+symbol: base URL, config
key, name, symbol, description, image sha256, first-buy and buy amounts, sell
rule, slippage, donation cause, quote mint and payer pubkey. Changing any of
them (including via `ACCEPTANCE_*` env overrides) changes the plan hash and
voids the approval.

```bash
# 1. get the plan + hash (no sends). Use the real payer keypair and the
#    deployed URL so the hash is the one --send will compute.
ACCEPTANCE_KEYPAIR=<payer.json> \
  node scripts/acceptance.mjs --dry-run --base-url https://skill.seekuplift.com
#    -> prints the full plan JSON and "PLAN HASH: <sha256>"

# 2. owner reviews the printed plan (incl. donation cause), then write the approval
cat > acceptance-approval.json <<'JSON'
{ "approved": true, "planHash": "<hash from step 1>",
  "approvedBy": "<owner>", "approvedAt": "<iso>" }
JSON

# 3. run for real against the deployed service
ACCEPTANCE_KEYPAIR=<payer.json> \
  node scripts/acceptance.mjs --send --base-url https://skill.seekuplift.com

# if a run stops partway (mint/pool/signatures are saved to the report as they
# land; failures print recovery steps), continue without relaunching:
ACCEPTANCE_KEYPAIR=<payer.json> \
  node scripts/acceptance.mjs --send --resume acceptance-report-<ts>.json
```

A second coin is never launched for the same plan hash: a prior report that
records a launched mint makes `--send` refuse and point at `--resume`.

Steps: docs → configs (meme default = creator-fee config) → launch + first
buy (sign/send/confirm) → find the coin via search (mint, symbol, name) AND list →
wait until the fee curve has reached its floor → buy → sell half → verify balances moved as quoted within
slippage. Every signature is printed and written to
`acceptance-report-*.json`. The script stops at the first miss.

## Dry-run result (2026-10-14, local service on :3011, backend :3033)

All read-only steps passed — docs fetch, configs check, launch tx build
(real image+metadata upload, mint-partial-signed tx parses, simulation
returns the expected unfunded-payer `AccountNotFound`), pools search/list,
buy and sell quote + unsigned tx build against a live curve pool (OILY).
`[SKIP-SEND]` markers confirmed no sign/send/confirm ran.
