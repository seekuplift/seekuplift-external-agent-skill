# Acceptance coin proposal — ticket 09

Proposed real coin for the real-coin acceptance run of every skill action
(`scripts/acceptance.mjs`). **Blocked on owner approval in chat** — the script
refuses `--send` until an approval file matching this exact name + symbol
exists, and until ticket 08's deployment is live. No transaction has been or
will be sent before that.

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
| `donation` | `{ "mode": "cause", "cause": "<first shipping slug from causesOffered>" }` when required, else omitted | Resolved at run time: the script POSTs without a donation first; on `400 donation_required` it re-posts with the first offered slug. On the dry-run backend no shipping cause was offered, so the launch was accepted with no donation. |
| `firstBuyAmount` | `100` SKR (display units — the config's `quote.firstBuyDefault`; service converts to atoms) | ≈ the suggested creator position. |
| buy amount | `10` SKR = `10000000` quote atoms (`ACCEPTANCE_BUY_AMOUNT`) | Small; inside the migration threshold by far. |
| sell amount | 50% of the purchased base balance (`ACCEPTANCE_SELL_BPS=5000`) | "Part of the balance" per the ticket. |
| `slippageBps` | `100` | 1% — small trade on a fresh curve. |
| payer | funded owner keypair from `ACCEPTANCE_KEYPAIR` | Needs ~0.02 SOL for fees/rent plus the SKR spend (~110 SKR total: 100 first buy + 10 buy). |

## Run plan (once owner approves + service is deployed)

```bash
# 1. record the approval (the gate)
cat > acceptance-approval.json <<'EOF'
{ "approved": true, "name": "Skill Acceptance Coin", "symbol": "SKACC",
  "approvedBy": "<owner>", "approvedAt": "<iso>", "note": "approved in chat" }
EOF

# 2. run for real against the deployed service
ACCEPTANCE_KEYPAIR=<payer.json> \
  node scripts/acceptance.mjs --send --base-url https://skill.seekuplift.com
```

Steps: docs → configs (meme default = creator-fee config) → launch + first
buy (sign/send/confirm) → find the coin via search AND list → wait out the
anti-sniper window → buy → sell half → verify balances moved as quoted within
slippage. Every signature is printed and written to
`acceptance-report-*.json`. The script stops at the first miss.

## Dry-run result (2026-10-14, local service on :3011, backend :3033)

All read-only steps passed — docs fetch, configs check, launch tx build
(real image+metadata upload, mint-partial-signed tx parses, simulation
returns the expected unfunded-payer `AccountNotFound`), pools search/list,
buy and sell quote + unsigned tx build against a live curve pool (OILY).
`[SKIP-SEND]` markers confirmed no sign/send/confirm ran.
