# Tickets: Dependency drift audit 2026-10-15 (external agent skill half)

Status: filed 2026-10-15 from the dependency behavioral-drift audit. Council of five seats affirmed both findings. Plan-reviewed 2026-10-15 r1 (opencode GLM 5.3): no findings; r2 (codex GPT 6 Astra): 1 applied (DD-S-1 `buyAmountSol` vs SKR-quoted config); AFK pass added the preview-backend default. Evidence was read at `1f62ecb` on `main` (module names locate it; line numbers are deliberately omitted); the fix for DD-S-1 was drafted on the `agent-api-update` branch (merged; its versioned-contract half landed separately). DD-S-1 landed on `main` 2026-10-15 (commit `027e7bf`); DD-S-2 remains ready-for-agent. This repo had no ticket file before; this is its first effort.
Sibling halves: backend `../backend-rs-sql/tickets-dependency-drift-2026-10-15.md` (DD-B-*), app `../redesign/launchpad-mobile-redesign/specs/tickets-dependency-drift-2026-10-15.md` (DD-A-*), programs + config `../dbc-config/tickets/tickets-dependency-drift-2026-10-15.md` (DD-D-*).

Non-negotiables:
- The skill contract is public: external agents cache `SKILL.md` and `skill.json`. Shape changes ship under a new version and path; the old shape keeps being served until a dated sunset.
- The DBC SDK version equals the app's exact pin; the agent must quote and build the same way the app does.
- No launch or trade transaction is sent from any ticket here; verification is unit and contract tests plus a dry-run against the preview backend named in the app's production manifest (`preview-app-api.seekuplift.com`; Authorized: read-only HTTP, no approval needed) or, if it is unreachable, against a recorded fixture — record which.

Frontier: DD-S-1, then DD-S-2.

## DD-S-1: Agents launch onto the prod-indexed config with a versioned contract

**Category:** bug. **Status:** done 2026-10-15 (commit `027e7bf`). **Priority:** P1. **Blocked by:** none.

`main` targets a DBC config key that production does not index, so coins launched by external agents never appear in the app, and the pool listing filters on the same key. The update branch moves to the live config and a configs endpoint but bumps the published contract to 2.0.0 in place, with no versioned path, no changelog, and no geo rules in the v1 document, so agents that cached v1 break when it ships. `SKILL.md` and `skill.json` are hand-written and already disagree on field names. Evidence: `src/lib/config.ts`, `SKILL.md`, `public/skill.json`, `src/app/api/pools/route.ts`, `docs/plans/2026-10-14-agent-api-update.md`.

Done when:
- [x] The default config key, the pools filter and both skill documents name the prod-indexed config; a test asserts they agree with one source constant.
- [x] v1's first-buy field `buyAmountSol` is defined explicitly for the new config, which is SKR-quoted (6 decimals), not SOL: the v1 launch route rejects a nonzero `buyAmountSol` before any upload when the selected config's quote mint is not wrapped SOL, with a documented migration error pointing at v2's quote-asset amount field; the contract tests assert the quote mint and the atomic amount in the constructed transaction, not only the response shape. `[PLAN REVIEW 2026-10-15 r2 (codex GPT 6 Astra), APPLIED: the route multiplies `buyAmountSol` by 1e9, so keeping the v1 shape would silently reinterpret a SOL amount as SKR atoms.]`
- [x] The v2 contract is served under a versioned path and the v1 path keeps serving the v1 shape (with the corrected config key) until a sunset date stated in both documents; a changelog lists the differences.
- [x] `skill.json` is generated from the same source as `SKILL.md` (or a test asserts every endpoint, field and fee claim in one appears in the other).
- [x] A contract test exercises launch, quote and pools against a recorded backend fixture for both versions.

## DD-S-2: Agent skill pinned to the app's SDK and fails loudly

**Category:** enhancement. **Status:** ready-for-agent. **Priority:** P2. **Blocked by:** DD-S-1 (same files; land the contract change first).

The DBC SDK is a caret range resolving to 1.5.7 while the app pins 1.5.13; two anchor copies (0.30.1 top-level, 0.31.1 nested in the SDK) interoperate only because they share one bn.js; the quote reads `outputAmount ?? amountOut ?? '0'` so a renamed SDK field returns a zero quote without error; the launch first-buy has no slippage floor; Node is unpinned and the documented image tag is floating and end-of-life. Evidence: `package.json`, `src/lib/dbc.ts`, `DEPLOY.md`, `next.config.js`.

Done when:
- [ ] The DBC SDK, web3.js and anchor are exact-pinned to the app's versions; `npm ls` shows one anchor and one bn.js; `DEPLOY.md` says `npm ci`.
- [ ] The quote throws a typed error when the SDK result has neither expected field; the first-buy passes a minimum-out derived from the quote and a documented slippage parameter.
- [ ] `engines` pins the Node major, the deploy image is referenced by digest, and the Next.js config flags that change meaning across majors carry a comment with the migration note.
- [ ] A CI job runs the contract tests from DD-S-1 on the pinned tree.
