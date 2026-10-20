# Tickets: Branded "…up" mint addresses (external agent skill half)

Status: VM-4 **done 2026-10-20**, landed on local `main` at `1efe07c` (not pushed: ready to push). Production deploy of this service: blocked-on-owner (human-only). Filed at skill `b6dd23d`.
Source: plan `../backend-rs-sql/docs/dev/vanity-mint-plan.md`, plan-reviewed 2026-10-20 (codex GPT 6 Astra, round 1). The backend half, with the owner decisions and the endpoint contract, is `../backend-rs-sql/tickets-vanity-mint.md` (VM-1). The app half is `../redesign/launchpad-mobile-redesign/specs/tickets-vanity-mint.md` (VM-2, VM-3). This file holds VM-4.

Non-negotiables:
- The skill contract is public: agents cache `SKILL.md` and `skill.json`. Changes are additive under the current version (v2). The frozen v1 docs are untouched.
- The mint secret is never logged or returned. The mint stays partially signed server-side as today.
- A caller-supplied `mintPublicKey` behaves exactly as today.
- Authorized: local tests, edits here, commits on `main` after `npm test` passes. [PLAN REVIEW 2026-10-20, OPEN (non-blocking): push authorization was inferred from the workspace landing rule, not given for this effort. Implement as: commit on the local default branch after the gate and report the commits as ready to push; do not push. The owner may overrule with "push it". If they do, push from the main checkout after the gate (pre-push hook enforces the tier).] Human-only: the production deploy of this service. Note it as blocked-on-owner and continue.

Frontier: VM-4 after VM-1.

## VM-4: Server-generated launch mints end in "up"

**Status:** done 2026-10-20 (`1efe07c`). **Blocked by:** VM-1 (backend endpoint contract; tests stub it).

When an agent calls `/api/launch` without its own `mintPublicKey`, the mint the service generates and signs ends in `up`, fetched from the backend's mint-keypair endpoint.

- **IP forwarding:** the launch route's already-validated client IP is passed through launch preparation into the mint generator and sent as `clientIp`, so the backend's per-network limit applies to the agent rather than this server.
- **Validation:** the response is checked the same way the app checks it: 64-byte secret, derived pubkey matches, address ends with `up`.
- **Fallback:** on any failure (timeout about 3 s, non-2xx, bad shape), the service signs a plain `Keypair.generate()` mint instead. The response reports this with a new additive `mintVanity: true|false` field, and `note` says when the mint is a plain one. The warning log carries no secret.
  - [PLAN REVIEW 2026-10-20, OPEN (non-blocking): automatic fallback was the planner's inference, not a user ruling. Implement as: fall back and report it via `mintVanity`. The owner may overrule to failing with a retryable 503 `vanity_unavailable`. If they do, drop the fallback and `mintVanity`, and document the 503 in the error table.]
- **Mint generation** is an injectable dependency of the launch builder, so tests run without a network.

Done when:
- [x] Builder tests: the injected generator's mint is used and signed (`mintVanity: true`), and a throwing generator falls back to a valid signed mint (`mintVanity: false`).
- [x] Launch orchestration test: the backend request receives the route's `clientIp`.
- [x] Validation test: a mismatched pubkey from the backend is rejected and falls back.
- [x] `SKILL.md` and `public/v2/skill.json` say that service-generated mints usually end in `up` (not guaranteed) and document `mintVanity`. Add a `CHANGELOG.md` minor entry. The docs agreement test passes. [AGENT CORRECTION 2026-10-20: the live doc is `public/skill.json` (no `v2/` dir), and the contract is a single unreleased 1.0.0, so the change is a bullet in that entry, not a new minor.]
- [x] One `/api/launch` against a local backend (VM-1 landed) returns a `mintAddress` ending in `up`, and the transaction carries the mint signature. No transaction is sent. [2026-10-20: verified by calling `buildLaunchTx` (the route's builder, default generator) against the VM-1 backend on :3947 with mainnet RPC reads: `…7up`, `mintVanity: true`, mint signature verifies. The HTTP route itself was not exercised end to end (it needs an image upload).]
- [x] `npm test` passes (378 pass, 0 fail). Commit on `main`. 3p review (opencode GLM 5.3): CLEAN.
