# Tickets: Coin discovery by interests (external agent skill half)

Status: filed 2026-11-02, nothing implemented.
Source: spec `../backend-rs-sql/docs/superpowers/specs/2026-11-02-coin-discovery-design.md` (owner-approved, codex plan review r1 applied). The backend half, with the endpoint contract, is `../backend-rs-sql/tickets-coin-discovery.md` (CD-B-1..4). This file holds CD-S-1.

Non-negotiables:
- The skill contract is public: agents cache `SKILL.md` and `skill.json`. Changes are additive.
- The query text is never logged or stored here either.
- Authorized: local tests, edits, commits on `main` after `npm test` passes, and pushing per the workspace landing rule. Human-only: the production deploy (it rides CD-B-4). Skill publicity stays human-gated: never make the repo public or announce the URL.

## CD-S-1: Agents can call `discover` through the skill

**Status:** ready-for-agent. **Blocked by:** None. Tests stub the backend contract from the spec; the deploy waits for CD-B-4.

An agent calls the skill's `discover` capability with a user's interests and gets the backend's shortlist back unchanged. `SKILL.md` teaches it to:
- use `discover`, not page through `list_pools`, for interest or value matching;
- summarize the user's interests in one short line, without names or identifying details;
- then quote and trade a chosen mint with the existing trade capabilities.

- A new discover route forwards to the backend with the caller IP, the same way the pools route does. It validates the request shape at the edge, applies the existing per-IP read rate limit, and passes backend errors through.
- `skill.json` gains the `discover` capability. `SKILL.md` documents the request, response, `mode`, `excludedForRegion` and the display-grade price note. Add a `CHANGELOG.md` entry.
- The wiki sample prompt needs no change; it now works as written.

Done when:
- [ ] Route tests: forwarding with `X-Forwarded-For`, edge validation, rate limiting, backend error passthrough, and no query text in logs.
- [ ] The docs agreement test passes with the new capability.
