# Tickets: Coin discovery by interests (external agent skill half)

Status: filed 2026-11-02. CD-S-1 done 2026-11-03 (`ff63725` on local `main`, unpushed); deploy waits on CD-B-4 (human-only).
Source: spec `../backend-rs-sql/docs/superpowers/specs/2026-11-02-coin-discovery-design.md` (owner-approved, codex plan review r1 applied). The backend half, with the endpoint contract, is `../backend-rs-sql/tickets-coin-discovery.md` (CD-B-1..4). This file holds CD-S-1.

Non-negotiables:
- The skill contract is public: agents cache `SKILL.md` and `skill.json`. Changes are additive.
- The query text is never logged or stored here either.
- Authorized: local tests, edits, commits on `main` after `npm test` passes, and pushing per the workspace landing rule. Human-only: the production deploy (it rides CD-B-4). Skill publicity stays human-gated: never make the repo public or announce the URL.

## CD-S-1: Agents can call `discover` through the skill

**2026-11-03 owner: hidden from the live service until the backend half ships.** The route 404s unless `DISCOVER_ENABLED=true`, and SKILL.md / `skill.json` / the landing page / CHANGELOG no longer mention discover. CD-B-4 re-enables it: set `DISCOVER_ENABLED=true` on both hosts and revert the docs-hiding commit (`git log --grep "hide discover"`).

**Status:** done (2026-11-03). Deploy still waits for CD-B-4 (human-only).

An agent calls the skill's `discover` capability with a user's interests and gets the backend's shortlist back unchanged. `SKILL.md` teaches it to:
- use `discover`, not page through `list_pools`, for interest or value matching;
- summarize the user's interests in one short line, without names or identifying details;
- then quote and trade a chosen mint with the existing trade capabilities.

- A new discover route forwards to the backend with the caller IP, the same way the pools route does. It validates the request shape at the edge, applies the existing per-IP read rate limit, and passes backend errors through.
- `skill.json` gains the `discover` capability. `SKILL.md` documents the request, response, `mode`, `excludedForRegion` and the display-grade price note. Add a `CHANGELOG.md` entry.
- The wiki sample prompt needs no change; it now works as written.

Done when:
- [x] Route tests: forwarding with `X-Forwarded-For`, edge validation, rate limiting, backend error passthrough, and no query text in logs.
- [x] The docs agreement test passes with the new capability.

**Landed 2026-11-03** (`ff63725`, now on local `main`; not pushed):
- `src/app/api/discover/route.ts` + `src/lib/discover.ts`: `POST
  /api/discover` forwards the body verbatim to the backend with the caller IP
  on `X-Forwarded-For` (`backendPostJson`), validates the request shape at the
  edge with the backend's own limits (400 `{ error: "invalid_request", field,
  message }` — the backend's own 400 shape), runs the shared per-network
  `checkAgentAccess` guard before the forward, and passes backend errors
  through (400/403/429 kept, others 502) — the trade-route pattern. All
  responses `cache-control: no-store`. Query text is never logged or echoed:
  refusals name the field only; the sole log line carries the error message
  (statuses/codes only).
- `public/skill.json` gains the `discover` capability (additive, between
  `list_pools` and `claim_fees`); `SKILL.md` §6 documents request, response,
  `mode` (semantic vs keyword), `excludedForRegion`, the display-grade price
  note, and the three agent teachings (discover-first, one-line anonymous
  summary, quote-then-trade); landing page `src/app/page.tsx` + `CHANGELOG.md`
  updated; `claim_fees` renumbered §6→§7.
- Verification: `npm test` 396 pass / 0 fail / 4 skipped (opt-in live);
  `npx tsc --noEmit` clean. New `tests/discover.test.ts` covers forwarding
  with XFF, every edge-validation field, the 429 guard order, backend error
  passthrough and the no-query-text rule (lib + route source pin).
- Third-party review (opencode, zai-coding-plan/glm-5.3, diff `main...HEAD` +
  this ticket + the design spec): **CLEAN**; two non-blocking notes applied —
  edge 400s now carry `message` like the backend's shape, and the cursor bound
  uses the same code-point count as the other fields.
