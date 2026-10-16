# Test fixtures

Real captured responses — nothing synthetic. Do not hand-edit; re-capture.
(`config-record.json` is vendored, not captured; see its row.)

| File | Source | Captured |
|---|---|---|
| `mobile-config.web.json` | `GET https://app-api.seekuplift.com/api/mobile-config?cluster=mainnet-beta&platform=web` (production backend-rs-sql) | 2026-10-14 |
| `pool-config-61UBwyZf….getAccountInfo.json` | mainnet JSON-RPC `getAccountInfo` (base64) for the live production launch config (SKR quote, 99%→1.25% anti-sniper, 16% creator) via `https://api.mainnet-beta.solana.com` | 2026-10-14 |
| `pool-config-4w9Rs2ew….getAccountInfo.json` | mainnet JSON-RPC `getAccountInfo` (base64) for the legacy USDC-quoted config (same fee schedule, `enableFirstSwapWithMinFee=0`) | 2026-10-14 |
| `stream-list.json` | `GET https://app-api.seekuplift.com/api/stream/list?partnerConfigs=61UBwyZf…&limit=5` — production `StreamListResponse` (items + nextCursor) | 2026-10-14 |
| `stream-list-graduated.json` | same endpoint with `tab=graduated` — real graduated pools (`graduated: true`, `bondingCurve: 1`) | 2026-10-14 |
| `causes.json` | `GET /api/causes` from a local backend-rs-sql (`{ causes: [...] }` envelope; production served `{"causes":[]}` at capture time) | 2026-10-15 |

Tests feed the account bytes through the real
`@meteora-ag/dynamic-bonding-curve-sdk` decoder via a stubbed `Connection`
(`getAccountInfo`/`getAccountInfoAndContext`), so the exercised path is the
production one.
| `config-record.json` | Vendored byte-for-byte from `dbc-config/configs/mainnet/config-record.json` at dbc-config commit `8996d43a0aace6a0c3f4787fd123fe41ef791df2` (TB-D-1), sha256 `d7a46296404c6dfd90b2d5e32bfccf0ecbc3ff5a1390e8a0777b9c1d9824b632` (pinned by `tests/config-record.test.ts`). To refresh: copy the new file, update this row and the pinned sha in the test. Reused by TB-S-4. | 2026-10-16 |
