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
| `config-record.json` | Vendored byte-for-byte from `dbc-config/configs/mainnet/config-record.json` at dbc-config commit `1942b7ca7697b01de4296423c881a2af1c5b7af5` (TB-D-1), sha256 `3908692975dd5a7f40e2b45011a6db485d019e9d90f44bab65257456c3357aa1` (pinned by `tests/config-record.test.ts`). To refresh: copy the new file, update this row and the pinned sha in the test. Reused by TB-S-4. | 2026-10-16 |

## `damm-position-claim/`

Vendored byte-for-byte from `dbc-config/tests/fixtures/transfer-fee-bootstrap-migration/` at dbc-config commit
`7e65959efed30524fbc3fe6564edd4d967699016` (captured 2026-10-16 on a local `solana-test-validator` running the deployed
mainnet DBC 0.2.2 and DAMM v2 dumps; cp-amm SDK 1.5.1, DBC SDK 1.5.13; migration config
`A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`). Used by `tests/claim-position.test.ts`. To refresh: re-copy, update
this row and the shas.

| File | sha256 |
|---|---|
| `flat-10-1000-damm-pool.json` (decoded migrated cp-amm Pool, creator-share coin) | `69c19aeb9b80a09f8bb74f1ad62db2c291cf4eeb0b26dabb6b93b58c415b0394` |
| `flat-10-1000-damm-positions.json` (partner + creator 30% position, NFT owners; captured AFTER the creator claim) | `2d89014766503751c568ff812f1d62e0e4d1d3a521c4c306306408e5b56b3592` |
| `flat-10-1000-creator-claim-tx.json` (real `getTransaction` of the creator's `claim_position_fee`) | `05d06e0d7ecb5dae1ed174c4484bd86f29af5d812fc789a352a940d8960db530` |
| `cause-flat-10-1000-damm-pool.json` (cause-only coin: no creator share) | `0f6262552cf0f5ab3d3c9e9c0574130ddbccc792103f2d5baf30b835a2019eed` |
| `cause-flat-10-1000-damm-positions.json` (single partner position, no creator position) | `b8e11309ca5fcabf2cbb88d898fbf20921b2598d6c161320980ce01572340b13` |
