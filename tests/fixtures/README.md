# Test fixtures

Real captured responses — nothing synthetic. Do not hand-edit; re-capture.

| File | Source | Captured |
|---|---|---|
| `mobile-config.web.json` | `GET https://app-api.seekuplift.com/api/mobile-config?cluster=mainnet-beta&platform=web` (production backend-rs-sql) | 2026-10-14 |
| `pool-config-61UBwyZf….getAccountInfo.json` | mainnet JSON-RPC `getAccountInfo` (base64) for the live production launch config (SKR quote, 99%→1.25% anti-sniper, 16% creator) via `https://api.mainnet-beta.solana.com` | 2026-10-14 |
| `pool-config-4w9Rs2ew….getAccountInfo.json` | mainnet JSON-RPC `getAccountInfo` (base64) for the legacy USDC-quoted config (same fee schedule, `enableFirstSwapWithMinFee=0`) | 2026-10-14 |

Tests feed the account bytes through the real
`@meteora-ag/dynamic-bonding-curve-sdk` decoder via a stubbed `Connection`
(`getAccountInfo`/`getAccountInfoAndContext`), so the exercised path is the
production one.
