/**
 * GET /api/configs catalog tests — real captured fixtures only (the
 * mobile-config payload is the production backend's response; the on-chain
 * configs are real `getAccountInfo` captures decoded by the real SDK).
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { describe, it, beforeEach, afterEach } from 'node:test'
import {
  getConfigCatalog,
  resetConfigCatalogCachesForTests,
  type CatalogDeps,
  type MobileConfigResponse,
} from '../src/lib/config-catalog.ts'
import {
  decodePoolConfigFixture,
  mobileConfigFixture,
  DONATION_CLAIM_AUTHORITY,
  LEGACY_CONFIG_ACCOUNT,
  LEGACY_CONFIG_KEY,
  LIVE_CONFIG_ACCOUNT,
  LIVE_CONFIG_KEY,
  TF_CONFIG_ACCOUNT,
  TF_CONFIG_FEE_CLAIMER,
} from './helpers.ts'

const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** Hermetic quote-mint read — the quote mint is always read on-chain now. */
const SPL_MINT_INFO: CatalogDeps['fetchMintInfo'] = async () => ({
  decimals: 6,
  tokenProgram: SPL_TOKEN_PROGRAM,
  scaledUiAmount: null,
})

/** Default deps: real mobile-config fixture + real decoded pool config. */
async function defaultDeps(overrides: Partial<CatalogDeps> = {}): Promise<CatalogDeps> {
  const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
  return {
    fetchMobileConfig: async () => mobileConfigFixture(),
    fetchPoolConfig: async (key) => (key === LIVE_CONFIG_KEY ? liveConfig : null),
    fetchMintInfo: SPL_MINT_INFO,
    donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    ...overrides,
  }
}

beforeEach(() => resetConfigCatalogCachesForTests())
afterEach(() => resetConfigCatalogCachesForTests())

describe('GET /api/configs catalog', () => {
  it('lists only the config keys the backend serves — nothing hardcoded', async () => {
    const { configs } = await getConfigCatalog('203.0.113.10', await defaultDeps())
    assert.equal(configs.length, 1)
    assert.equal(configs[0].configKey, LIVE_CONFIG_KEY)
    assert.deepEqual(configs[0].categories, ['meme', 'idea', 'startup'])
    assert.equal(configs[0].optionId, 'default')
  })

  it('keeps the live config’s 99% opening rate and full decoded schedule', async () => {
    const { configs } = await getConfigCatalog('203.0.113.10', await defaultDeps())
    const entry = configs.find((c) => c.configKey === LIVE_CONFIG_KEY)
    assert.ok(entry)
    assert.equal(entry.decodeError, null)
    // On-chain decode: cliff 990,000,000 → 9900 bps = 99% opening fee.
    assert.equal(entry.fees.curve.kind, 'decay')
    assert.equal(entry.fees.curve.openingBps, 9900)
    // 20 periods × 48,875,000 reduction → 125 bps = 1.25% floor.
    assert.equal(entry.fees.curve.floorBps, 125)
    assert.equal(entry.fees.curve.decay, 'time')
    assert.equal(entry.fees.curve.decayPeriods, 20)
    assert.equal(entry.fees.curve.decayPeriodLength, 75)
    assert.equal(entry.fees.curve.decayUnit, 'slots')
    assert.equal(entry.fees.curve.decaySecondsEstimate, 600)
    assert.equal(entry.fees.curve.dynamic, true)
    // migrationFeeOption 0 → the 25 bps DAMM v2 preset (NOT a 0% fee).
    assert.deepEqual(entry.fees.postGraduation, {
      kind: 'flat',
      startBps: 25,
      floorBps: 25,
      decay: 'none',
    })
    assert.equal(entry.fees.creatorSharePct, 16)
    assert.equal(entry.fees.allFeesToCause, false)
    assert.equal(entry.fees.transferFeeBps, 0)
    assert.match(entry.fees.label, /99%/)
    assert.match(entry.fees.label, /1\.25%/)
    // Quote + capability fields.
    assert.equal(entry.quote.mint, SKR_MINT)
    assert.equal(entry.quote.symbol, 'SKR')
    assert.equal(entry.quote.decimals, 6)
    assert.equal(entry.quote.tokenProgram, SPL_TOKEN_PROGRAM)
    assert.equal(entry.quote.scaledUiAmountMultiplier, null)
    assert.equal(entry.supportsFirstBuy, true)
    assert.equal(entry.supportsCause, true)
    assert.equal(entry.isStock, false)
    assert.equal(entry.poolCreationFeeLamports, '0')
    assert.equal(entry.migrationQuoteThreshold, '613068600')
    assert.deepEqual(entry.defaultFor, ['meme'])
    // Open geo for an unrestricted caller.
    assert.deepEqual(entry.geo.allowed, true)
    assert.equal(entry.geo.reason, null)
    assert.equal(entry.geo.region, 'PE')
    assert.equal(entry.geo.byCategory.meme?.allowed, true)
    assert.equal(entry.geo.byCategory.idea?.allowed, true)
    assert.equal(entry.geo.byCategory.startup?.allowed, true)
  })

  it('fetches geo fresh per request with the caller IP — two callers never share a verdict', async () => {
    const calls: (string | null)[] = []
    const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
    const deps: CatalogDeps = {
      fetchMobileConfig: async (clientIp) => {
        calls.push(clientIp)
        const restricted =
          clientIp === '198.51.100.7' ? ['idea.create', 'startup.create'] : []
        return mobileConfigFixture({
          geo: { region: clientIp === '198.51.100.7' ? 'US' : 'PE', restricted, betaGated: false },
        })
      },
      fetchPoolConfig: async (key) => (key === LIVE_CONFIG_KEY ? liveConfig : null),
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    }
    const a = await getConfigCatalog('198.51.100.7', deps)
    const b = await getConfigCatalog('203.0.113.10', deps)
    // Both callers fetched their own mobile-config (geo is never cached).
    assert.deepEqual(calls, ['198.51.100.7', '203.0.113.10'])
    const entryA = a.configs[0]
    const entryB = b.configs[0]
    assert.equal(entryA.geo.region, 'US')
    assert.equal(entryA.geo.byCategory.idea?.allowed, false)
    assert.equal(entryA.geo.byCategory.idea?.reason, 'idea.create')
    assert.equal(entryA.geo.byCategory.startup?.allowed, false)
    assert.equal(entryA.geo.byCategory.meme?.allowed, true)
    assert.equal(entryA.geo.allowed, false)
    assert.equal(entryA.geo.reason, 'idea.create')
    assert.equal(entryB.geo.region, 'PE')
    assert.equal(entryB.geo.allowed, true)
    assert.equal(entryB.geo.byCategory.idea?.allowed, true)
  })

  it('reuses parsed options within 60s for the same backend version, reparses after', async () => {
    let clock = 1_000_000
    const calls: string[] = []
    const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
    const deps: CatalogDeps = {
      now: () => clock,
      fetchMobileConfig: async () => {
        calls.push('fetch')
        // Same version, but a DOCTORED option list — the version-keyed cache
        // must keep serving the originally parsed options.
        const fixture = mobileConfigFixture()
        return calls.length > 1
          ? {
              ...fixture,
              launchConfigOptions: { meme: [], idea: [], startup: [] },
              launchConfigKeys: {},
            }
          : fixture
      },
      fetchPoolConfig: async (key) => (key === LIVE_CONFIG_KEY ? liveConfig : null),
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    }
    const first = await getConfigCatalog('203.0.113.10', deps)
    assert.equal(first.configs.length, 1)
    const second = await getConfigCatalog('203.0.113.10', deps)
    assert.equal(calls.length, 2) // mobile-config still fetched (geo is fresh)
    assert.equal(second.configs.length, 1) // but the cached parse won
    clock += 61_000
    const third = await getConfigCatalog('203.0.113.10', deps)
    assert.equal(third.configs.length, 0) // after ~60s the new payload parses
  })

  it('supportsCause fails closed when the env list is unset or the claimer undecodable', async () => {
    const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
    // Unset/empty list → not capable even though the claimer is real.
    const empty = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => mobileConfigFixture(),
      fetchPoolConfig: async () => liveConfig,
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [],
    })
    assert.equal(empty.configs[0].supportsCause, false)
    assert.equal(empty.configs[0].fees.allFeesToCause, false)

    resetConfigCatalogCachesForTests() // clear the per-configKey decode cache between sub-cases

    // Undecodable claimer → not capable.
    const noClaimer = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => mobileConfigFixture(),
      fetchPoolConfig: async () => ({ ...liveConfig, feeClaimer: undefined }),
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    assert.equal(noClaimer.configs[0].supportsCause, false)
  })

  it('allFeesToCause = creator share 0 AND cause-capable', async () => {
    const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
    const zeroShare = { ...liveConfig, creatorTradingFeePercentage: 0 }
    // Cause-capable zero-share → all fees to cause.
    const cause = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => mobileConfigFixture(),
      fetchPoolConfig: async () => zeroShare,
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    assert.equal(cause.configs[0].fees.creatorSharePct, 0)
    assert.equal(cause.configs[0].supportsCause, true)
    assert.equal(cause.configs[0].fees.allFeesToCause, true)
    assert.match(cause.configs[0].fees.label, /all to cause/)

    resetConfigCatalogCachesForTests()

    // Non-capable zero-share → NOT all-fees-to-cause.
    const notCapable = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => mobileConfigFixture(),
      fetchPoolConfig: async () => ({ ...zeroShare, feeClaimer: 'So11111111111111111111111111111111111111112' }),
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    assert.equal(notCapable.configs[0].fees.allFeesToCause, false)
  })

  it('memecoin default = first meme option with creator share > 0, never an all-fees-to-cause config', async () => {
    const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
    const causeOnlyConfig = { ...liveConfig, creatorTradingFeePercentage: 0 }
    const fixture = mobileConfigFixture()
    // A cause-only config FIRST in the meme list — the default must skip it.
    const options = {
      meme: [
        { configKey: LEGACY_CONFIG_KEY, optionId: 'cause-flat', quoteMint: SKR_MINT },
        { configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT },
      ],
      idea: [{ configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT }],
      startup: [{ configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT }],
    }
    const { configs } = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => ({ ...fixture, launchConfigOptions: options, version: 'v-multi' }),
      fetchPoolConfig: async (key) =>
        key === LIVE_CONFIG_KEY ? liveConfig : key === LEGACY_CONFIG_KEY ? causeOnlyConfig : null,
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    assert.equal(configs.length, 2)
    const causeEntry = configs.find((c) => c.configKey === LEGACY_CONFIG_KEY)!
    const liveEntry = configs.find((c) => c.configKey === LIVE_CONFIG_KEY)!
    assert.equal(causeEntry.fees.allFeesToCause, true)
    assert.deepEqual(causeEntry.defaultFor, [])
    assert.deepEqual(liveEntry.defaultFor, ['meme'])
  })

  it('meme geo verdict uses cause.marketing (no meme.create); stock adds stock.create', async () => {
    const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
    const fixture = mobileConfigFixture()
    const memeRestricted = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => ({
        ...fixture,
        geo: { region: 'US', restricted: ['cause.marketing'], betaGated: false },
        version: 'v-geo1',
      }),
      fetchPoolConfig: async () => liveConfig,
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    const entry = memeRestricted.configs[0]
    assert.equal(entry.geo.byCategory.meme?.allowed, false)
    assert.equal(entry.geo.byCategory.meme?.reason, 'cause.marketing')
    assert.equal(entry.geo.byCategory.idea?.allowed, true)
    assert.equal(entry.geo.byCategory.startup?.allowed, true)

    resetConfigCatalogCachesForTests()

    // A stock-quoted config: stock.create stacks on the category key.
    const stockConfig = { ...liveConfig, quoteMint: 'FakeStockMint11111111111111111111111111111' }
    const stockOptions = {
      meme: [{ configKey: LIVE_CONFIG_KEY, optionId: 'aaplx', quoteMint: 'FakeStockMint11111111111111111111111111111' }],
    }
    const stock = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => ({
        ...fixture,
        launchConfigOptions: stockOptions,
        quoteAssets: [
          { mint: 'FakeStockMint11111111111111111111111111111', symbol: 'AAPLx', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
        ],
        geo: { region: 'US', restricted: ['stock.create'], betaGated: false },
        version: 'v-geo2',
      }),
      fetchPoolConfig: async () => stockConfig,
      fetchMintInfo: async () => ({ decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', scaledUiAmount: null }),
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    const stockEntry = stock.configs[0]
    assert.equal(stockEntry.isStock, true)
    assert.equal(stockEntry.geo.byCategory.meme?.allowed, false)
    assert.equal(stockEntry.geo.byCategory.meme?.reason, 'stock.create')
  })

  it('fails closed when a non-SPL quote mint read cannot prove the mint is unscaled', async () => {
    const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
    const fixture = mobileConfigFixture()
    const stockMint = 'FakeStockMint11111111111111111111111111111'
    const stockConfig = { ...liveConfig, quoteMint: stockMint }
    const stockMobileConfig = {
      ...fixture,
      launchConfigOptions: {
        meme: [{ configKey: LIVE_CONFIG_KEY, optionId: 'aaplx', quoteMint: stockMint }],
      },
      quoteAssets: [
        { mint: stockMint, symbol: 'AAPLx', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
      ],
      version: 'v-mintfail',
    }
    // A throwing mint read → decodeError (app: `resolveQuoteAssetForLaunch`
    // throws "Unable to resolve mint info" rather than launching with
    // multiplier 1 on a mint that may carry ScaledUiAmount).
    const throwing = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => stockMobileConfig,
      fetchPoolConfig: async () => stockConfig,
      fetchMintInfo: async () => {
        throw new Error('RPC down')
      },
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    const entry = throwing.configs[0]
    assert.equal(entry.isStock, true)
    assert.match(entry.decodeError ?? '', /Unable to resolve mint info/)
    assert.equal(entry.quote.scaledUiAmountMultiplier, null)

    resetConfigCatalogCachesForTests()

    // A read that returns no decimals fails closed the same way.
    const undecodable = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => stockMobileConfig,
      fetchPoolConfig: async () => stockConfig,
      fetchMintInfo: async () => ({
        decimals: null,
        tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        scaledUiAmount: null,
      }),
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    assert.match(undecodable.configs[0].decodeError ?? '', /Unable to resolve mint info/)
  })

  it('degrades gracefully when a served config cannot be decoded', async () => {
    const { configs } = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => mobileConfigFixture(),
      fetchPoolConfig: async () => null,
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    })
    const entry = configs[0]
    assert.equal(entry.decodeError != null, true)
    assert.equal(entry.supportsCause, false)
    assert.equal(entry.supportsFirstBuy, false)
    assert.equal(entry.fees.creatorSharePct, null)
    assert.equal(entry.fees.transferFeeBps, null)
    assert.equal(entry.fees.curve.kind, 'custom')
    assert.deepEqual(entry.defaultFor, [])
    // The quote mint still falls back to the backend-served option mint.
    assert.equal(entry.quote.mint, SKR_MINT)
    assert.equal(entry.quote.symbol, 'SKR')
  })

  it('does not cache a failed pool-config fetch', async () => {
    let calls = 0
    const liveConfig = await decodePoolConfigFixture(LEGACY_CONFIG_ACCOUNT)
    const fixture = mobileConfigFixture()
    const deps: CatalogDeps = {
      fetchMobileConfig: async () => ({
        ...fixture,
        launchConfigOptions: {
          meme: [{ configKey: LEGACY_CONFIG_KEY, optionId: 'x', quoteMint: USDC_MINT }],
        },
        launchConfigKeys: {},
        version: 'v-flaky',
      }),
      fetchPoolConfig: async () => {
        calls += 1
        if (calls === 1) throw new Error('RPC down')
        return liveConfig
      },
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
    }
    const first = await getConfigCatalog('203.0.113.10', deps)
    assert.equal(first.configs[0].decodeError, 'RPC down')
    const second = await getConfigCatalog('203.0.113.10', deps)
    assert.equal(calls, 2) // retried — failures are never cached
    assert.equal(second.configs[0].decodeError, null)
    assert.equal(second.configs[0].quote.mint, USDC_MINT)
    assert.equal(second.configs[0].supportsFirstBuy, false) // legacy flag 0
    // Third call hits the per-configKey cache — no refetch.
    const third = await getConfigCatalog('203.0.113.10', deps)
    assert.equal(calls, 2)
    assert.equal(third.configs[0].decodeError, null)
  })

  it('a tf-bootstrap config reports its coin transfer fee (real Dird7tkG… account)', async () => {
    const tfConfig = await decodePoolConfigFixture(TF_CONFIG_ACCOUNT)
    const { configs } = await getConfigCatalog('203.0.113.10', {
      fetchMobileConfig: async () => mobileConfigFixture(),
      fetchPoolConfig: async () => tfConfig,
      fetchMintInfo: SPL_MINT_INFO,
      donationClaimAuthorities: [TF_CONFIG_FEE_CLAIMER],
    })
    const entry = configs[0]
    assert.equal(entry.decodeError, null)
    assert.equal(entry.fees.transferFeeBps, 100)
    assert.ok(entry.fees.details.includes('Coin transfer fee: 1% of every transfer of the coin, trades included'))
    assert.equal(entry.fees.creatorSharePct, 30)
    assert.equal(entry.supportsCause, true)
    assert.equal(entry.supportsFirstBuy, true)
  })
})
