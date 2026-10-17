/**
 * `/api/trade/*` orchestration tests — `prepareTradeQuote` / `prepareTradeTx`
 * in src/lib/trade.ts — driven through the injectable seams: a stub SDK
 * client, prototype-patched Connection reads, a fixture mobile-config fetch,
 * and a stubbed backend pool-metadata fetch. Asserts:
 *
 *   - side mapping: buy → `swapQuote2`/`swap2` PartialFill; sell →
 *     `swapQuote`/`swap` full-fill (QA-34);
 *   - TF-APP-1: the sell transaction transfers the GROSS input while the
 *     quote/net math runs on the fee-excluded amount; the buy floor derives
 *     from the NET output;
 *   - CA-A-5: `migration_pending` refuses as a retry-later state and
 *     `migrated` points to Jupiter — never a curve quote/build on either;
 *   - trade geo: `<category>.trade` for idea/startup coins, `stock.trade` for
     stock-quoted coins, memecoin trading never gated (D4).
 */
import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  GeoRestrictedError,
} from '../src/lib/launch.ts'
import {
  PoolNotTradeableError,
  prepareTradeQuote,
  prepareTradeTx,
  TradeError,
  type TradeDeps,
} from '../src/lib/trade.ts'
import type { MobileConfigResponse } from '../src/lib/config-catalog.ts'
import { resetConfigCatalogCachesForTests } from '../src/lib/config-catalog.ts'
import { loadFixture } from './helpers.ts'

const POOL_ADDRESS = '9uFg8xPfLVVn92qeiNoBSURZdtSYYsByfp7id1WFVj3b'
const OWNER_ADDRESS = 'HWxH6KJk8u5fcMQgAZMv92mSzSHUDjPQHvRwhSS75dRj'
const BASE_MINT = 'EYhMhoZEMnr9EJUYAAU8TX4NNEaM12yNHW2xPUgyuZMc'
const QUOTE_MINT = 'So11111111111111111111111111111111111111112'
const CONFIG_ADDRESS = 'FEAmFp76ezVdR8wvSEtuHVEZw1QJ9MQoupDMcqXECbLD'
const STOCK_QUOTE_MINT = 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const TF_MINT_1000 = loadFixture<{ data: unknown }>('tf-flat-10-1000-mint.json')
const TF_SELL_IN_1000 = 311_754_270_115_898n
const TF_SELL_FEE_1000 = 31_175_427_011_590n

const bnLike = (value: bigint | number | string) => ({ toString: () => String(value) })

// ─── Mock state ──────────────────────────────────────────────────────────────
let swapQuoteCalls: Record<string, unknown>[] = []
let swapQuote2Calls: Record<string, unknown>[] = []
let swapCalls: Record<string, unknown>[] = []
let swap2Calls: Record<string, unknown>[] = []
let mockPoolExists: boolean | 'not-a-pool' = true
let mockQuoteReserve: bigint | number = 0
let mockIsMigrated: number | undefined = 0
let mockMigrationProgress: number | undefined = 0
let mockQuoteMint = QUOTE_MINT
let mockTokenType = 0
let mockGeo: MobileConfigResponse['geo'] = { region: 'US', restricted: [] }
let mockOptions: MobileConfigResponse['launchConfigOptions'] = {}
let mockQuoteAssets: unknown = []
let mockLaunchType: string | null = null
let metadataFetchThrows = false

function makeMockClient(): DynamicBondingCurveClient {
  return {
    state: {
      getPool: async () => {
        if (mockPoolExists === 'not-a-pool') throw new Error('Invalid account discriminator')
        return mockPoolExists
          ? {
              baseMint: new PublicKey(BASE_MINT),
              config: new PublicKey(CONFIG_ADDRESS),
              quoteReserve: bnLike(mockQuoteReserve),
              isMigrated: mockIsMigrated,
              migrationProgress: mockMigrationProgress,
            }
          : null
      },
      getPoolConfig: async () => ({
        quoteMint: new PublicKey(mockQuoteMint),
        migrationQuoteThreshold: bnLike(1_000_000_000),
        activationType: 0,
        tokenType: mockTokenType,
      }),
    },
    pool: {
      swapQuote: (args: Record<string, unknown>) => {
        swapQuoteCalls.push(args)
        const requested = (args.amountIn as { toString(): string }).toString()
        return {
          outputAmount: bnLike(1_000_000n),
          minimumAmountOut: bnLike(950_000n),
          includedFeeInputAmount: bnLike(requested),
          amountLeft: bnLike(0),
        }
      },
      swapQuote2: (args: Record<string, unknown>) => {
        swapQuote2Calls.push(args)
        const requested = (args.amountIn as { toString(): string }).toString()
        return {
          outputAmount: bnLike(900_000n),
          minimumAmountOut: bnLike(855_000n),
          includedFeeInputAmount: bnLike(requested),
          amountLeft: bnLike(0),
        }
      },
      swap: async (args: Record<string, unknown>) => {
        swapCalls.push(args)
        return new Transaction()
      },
      swap2: async (args: Record<string, unknown>) => {
        swap2Calls.push(args)
        return new Transaction()
      },
    },
  } as unknown as DynamicBondingCurveClient
}

const connection = new Connection('http://127.0.0.1:1')

type Restore = () => void
const restores: Restore[] = []
function patch(key: string, fn: unknown): void {
  const proto = Connection.prototype as unknown as Record<string, unknown>
  const original = proto[key]
  proto[key] = fn
  restores.push(() => {
    proto[key] = original
  })
}

function makeDeps(): TradeDeps {
  return {
    connection,
    client: makeMockClient(),
    catalogDeps: {
      fetchMobileConfig: async () => ({
        cluster: 'mainnet-beta',
        geo: mockGeo,
        launchConfigOptions: mockOptions,
        quoteAssets: mockQuoteAssets,
        version: 'test-v1',
      }),
    },
    fetchPoolMetadata: async () => {
      if (metadataFetchThrows) throw new Error('backend down')
      return { launchType: mockLaunchType }
    },
  }
}

beforeEach(() => {
  resetConfigCatalogCachesForTests()
  swapQuoteCalls = []
  swapQuote2Calls = []
  swapCalls = []
  swap2Calls = []
  mockPoolExists = true
  mockQuoteReserve = 0
  mockIsMigrated = 0
  mockMigrationProgress = 0
  mockQuoteMint = QUOTE_MINT
  mockTokenType = 0
  mockGeo = { region: 'US', restricted: [] }
  mockOptions = {}
  mockQuoteAssets = []
  mockLaunchType = null
  metadataFetchThrows = false
  patch('getSlot', async () => 1)
  patch('getLatestBlockhash', async () => ({
    blockhash: '4uQeVj5tqViQh7yWWGStvkEG1RgTksVZc8k1q1iT1c1k',
    lastValidBlockHeight: 1,
  }))
  patch('getParsedAccountInfo', async (mint: PublicKey) => ({
    value: {
      data: { parsed: { info: { decimals: mint.toString() === BASE_MINT ? 8 : 9 } } },
    },
  }))
  patch('getAccountInfo', async () => null)
  patch('simulateTransaction', async () => {
    throw new Error('simulateTransaction not available in tests')
  })
  patch('getRecentPrioritizationFees', async () => [])
})

afterEach(() => {
  while (restores.length) restores.pop()?.()
})

// ─── Validation ──────────────────────────────────────────────────────────────
describe('prepareTradeQuote — request validation', () => {
  for (const [label, body] of [
    ['missing poolAddress', { side: 'buy', amountIn: '100' }],
    ['bad side', { poolAddress: POOL_ADDRESS, side: 'hold', amountIn: '100' }],
    ['missing amountIn', { poolAddress: POOL_ADDRESS, side: 'buy' }],
    ['non-integer amountIn', { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '1.5' }],
    ['non-numeric amountIn', { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: 'abc' }],
    ['negative amountIn (string)', { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '-5' }],
    ['negative amountIn (number)', { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: -5 }],
    ['amountIn above u64 max', { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '18446744073709551616' }],
    ['zero amountIn', { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '0' }],
    ['bad slippage', { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '1', slippageBps: -1 }],
    ['slippage above every cap', { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '1', slippageBps: 10001 }],
    ['not an object', null],
  ] as const) {
    it(`rejects ${label} as a 400`, async () => {
      await assert.rejects(prepareTradeQuote(body, null, makeDeps()), (err: unknown) => {
        assert.ok(err instanceof TradeError)
        assert.equal(err.status, 400)
        return true
      })
    })
  }

  it('prepareTradeTx rejects minimumAmountOut above u64 max as a 400', async () => {
    await assert.rejects(
      prepareTradeTx(
        {
          poolAddress: POOL_ADDRESS,
          side: 'buy',
          amountIn: '1',
          payerPublicKey: POOL_ADDRESS,
          minimumAmountOut: '18446744073709551616',
        },
        null,
        makeDeps(),
      ),
      (err: unknown) => {
        assert.ok(err instanceof TradeError)
        assert.equal(err.status, 400)
        return true
      },
    )
  })

  it('a missing pool resolves as a 404 pool_not_found', async () => {
    mockPoolExists = false
    await assert.rejects(
      prepareTradeQuote({ poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' }, null, makeDeps()),
      (err: unknown) => {
        assert.ok(err instanceof TradeError)
        assert.equal(err.status, 404)
        assert.equal(err.fields.error, 'pool_not_found')
        return true
      },
    )
  })

  it('an account that is not a DBC pool (wallet, mint) is also a 404', async () => {
    mockPoolExists = 'not-a-pool'
    await assert.rejects(
      prepareTradeQuote({ poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' }, null, makeDeps()),
      (err: unknown) => err instanceof TradeError && err.status === 404,
    )
  })
})

// ─── Quote happy path (QA-34 side mapping) ───────────────────────────────────
describe('prepareTradeQuote — sides', () => {
  it('buy quotes through swapQuote2/PartialFill and echoes the pool facts', async () => {
    const result = await prepareTradeQuote(
      { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '2000000' },
      '203.0.113.7',
      makeDeps(),
    )
    assert.equal(swapQuote2Calls.length, 1)
    assert.equal(swapQuoteCalls.length, 0)
    assert.equal(swapQuote2Calls[0].swapMode, SwapMode.PartialFill)
    assert.equal(result.amountOut, '900000')
    assert.equal(result.minimumAmountOut, '855000')
    assert.equal(result.consumedInput, '2000000')
    assert.equal(result.amountLeft, '0')
    assert.equal(result.slippageBps, 50, 'default slippage is 50 bps')
    assert.equal(result.poolInfo.migrationState, 'curve')
    assert.equal(result.poolInfo.configKey, CONFIG_ADDRESS)
    assert.equal(result.poolInfo.quoteMint, QUOTE_MINT)
  })

  it('sell quotes through the full-fill swapQuote', async () => {
    const result = await prepareTradeQuote(
      { poolAddress: POOL_ADDRESS, side: 'sell', amountIn: '1000000' },
      null,
      makeDeps(),
    )
    assert.equal(swapQuoteCalls.length, 1)
    assert.equal(swapQuote2Calls.length, 0)
    assert.equal(result.amountOut, '1000000')
    assert.equal(result.amountLeft, '0')
  })

  it('the slippage bound edges are accepted: 0 and 1000, 5000 with allowHighSlippage', async () => {
    for (const [slippageBps, allowHighSlippage] of [[0, false], [1_000, false], [5_000, true]] as const) {
      const result = await prepareTradeQuote(
        { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100', slippageBps, allowHighSlippage },
        null,
        makeDeps(),
      )
      assert.equal(result.slippageBps, slippageBps)
    }
  })

  for (const [label, slippageBps, allowHighSlippage, max] of [
    ['above 1000 without the opt-in', 1_001, false, 1_000],
    ['10000 (zero floor) without the opt-in', 10_000, false, 1_000],
    ['above 5000 even with the opt-in', 5_001, true, 5_000],
    ['10000 (zero floor) even with the opt-in', 10_000, true, 5_000],
    ['far above the old 0–10000 range', 20_000, false, 1_000],
  ] as const) {
    it(`rejects slippage ${label} as 400 slippage_too_high`, async () => {
      await assert.rejects(
        prepareTradeQuote(
          { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100', slippageBps, allowHighSlippage },
          null,
          makeDeps(),
        ),
        (err: unknown) => {
          assert.ok(err instanceof TradeError)
          assert.equal(err.status, 400)
          assert.equal(err.fields.error, 'slippage_too_high')
          assert.equal(err.fields.maxSlippageBps, max)
          return true
        },
      )
    })
  }
})

// ─── TF-APP-1 through the orchestration ──────────────────────────────────────
describe('prepareTradeTx — transfer-fee mint (TF-APP-1)', () => {
  beforeEach(() => {
    mockTokenType = 1
    patch('getParsedAccountInfo', async (mint: PublicKey) => ({
      value: { data: mint.toString() === BASE_MINT ? TF_MINT_1000.data : null },
    }))
    patch('getEpochInfo', async () => ({ epoch: 0 }) as never)
  })

  it('the sell tx transfers the GROSS input while quoting the fee-excluded receipt', async () => {
    const result = await prepareTradeTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerPublicKey: OWNER_ADDRESS,
        side: 'sell',
        amountIn: String(TF_SELL_IN_1000),
      },
      null,
      makeDeps(),
    )
    assert.equal(swapCalls.length, 1, 'sell tx goes through pool.swap')
    const swapArgs = swapCalls[0]
    assert.equal(
      (swapArgs.amountIn as { toString(): string }).toString(),
      String(TF_SELL_IN_1000),
      'the tx transfers the gross amount — the vault withholds the fee itself',
    )
    // The internal quote ran on the fee-excluded vault receipt.
    const quoteArgs = swapQuoteCalls[0]
    assert.equal(
      (quoteArgs.amountIn as { toString(): string }).toString(),
      String(TF_SELL_IN_1000 - TF_SELL_FEE_1000),
    )
    assert.equal(result.quote?.baseTransferFeeAtomics, String(TF_SELL_FEE_1000))
    assert.equal(result.quote?.consumedInput, String(TF_SELL_IN_1000))
    assert.ok(result.transaction.length > 0)
  })

  it('the buy tx floor derives from the NET output (fee-excluded)', async () => {
    // The mocked swapQuote2 output is 900_000 gross → net is 900_000 − 10%.
    await prepareTradeTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerPublicKey: OWNER_ADDRESS,
        side: 'buy',
        amountIn: '50000000',
      },
      null,
      makeDeps(),
    )
    assert.equal(swap2Calls.length, 1)
    const args = swap2Calls[0]
    const net = 900_000n - (900_000n * 1_000n + 9_999n) / 10_000n
    assert.equal(
      (args.minimumAmountOut as { toString(): string }).toString(),
      String((net * 9_950n) / 10_000n),
      'minimumAmountOut is slippage over the net, not the gross SDK floor',
    )
  })

  it('a caller-supplied minimumAmountOut at/above the fresh-quote floor is used (tighten-only)', async () => {
    const result = await prepareTradeTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerPublicKey: OWNER_ADDRESS,
        side: 'sell',
        amountIn: '1000000',
        minimumAmountOut: '990000', // mock sell floor is 950000 — tightened
      },
      null,
      makeDeps(),
    )
    const args = swapCalls[0]
    assert.equal((args.minimumAmountOut as { toString(): string }).toString(), '990000')
    // TB-S-3: the internal quote ALWAYS runs — it is the floor source — and
    // is always reported.
    assert.equal(swapQuoteCalls.length, 1)
    assert.ok(result.quote)
    assert.equal(result.quote.minimumAmountOut, '950000')
    // IV-S-1: the response carries the expiry bound the tx was built with.
    assert.equal(result.lastValidBlockHeight, 1)
  })

  it('a minimumAmountOut equal to the fresh floor is accepted verbatim', async () => {
    await prepareTradeTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerPublicKey: OWNER_ADDRESS,
        side: 'sell',
        amountIn: '1000000',
        minimumAmountOut: '950000',
      },
      null,
      makeDeps(),
    )
    assert.equal(
      (swapCalls[0].minimumAmountOut as { toString(): string }).toString(),
      '950000',
    )
  })

  it('a looser minimumAmountOut is a 400 naming the floor — never loosened', async () => {
    for (const [label, supplied] of [
      ['just below the floor', '949999'],
      ['zero (old slippage-disable escape)', '0'],
      ['one atom', '1'],
    ] as const) {
      await assert.rejects(
        prepareTradeTx(
          {
            poolAddress: POOL_ADDRESS,
            ownerPublicKey: OWNER_ADDRESS,
            side: 'sell',
            amountIn: '1000000',
            minimumAmountOut: supplied,
          },
          null,
          makeDeps(),
        ),
        (err: unknown) => {
          assert.ok(err instanceof TradeError, `${label}: ${err}`)
          assert.equal(err.status, 400, label)
          assert.equal(err.fields.error, 'min_out_below_floor', label)
          assert.equal(err.fields.minimumAmountOutFloor, '950000', label)
          return true
        },
      )
    }
    assert.equal(swapCalls.length + swap2Calls.length, 0, 'no transaction was built')
  })

  it('slippageBps 10000 cannot zero the floor — 400 slippage_too_high, no tx', async () => {
    await assert.rejects(
      prepareTradeTx(
        {
          poolAddress: POOL_ADDRESS,
          ownerPublicKey: OWNER_ADDRESS,
          side: 'sell',
          amountIn: '1000000',
          slippageBps: 10_000,
          allowHighSlippage: true,
        },
        null,
        makeDeps(),
      ),
      (err: unknown) => {
        assert.ok(err instanceof TradeError)
        assert.equal(err.fields.error, 'slippage_too_high')
        return true
      },
    )
    assert.equal(swapCalls.length + swap2Calls.length, 0, 'no transaction was built')
  })
})

// ─── CA-A-5: migration states gate before quote/build ────────────────────────
describe('migration-state gate (CA-A-5)', () => {
  it('migration_pending refuses as retryable — no curve quote, no tx', async () => {
    mockQuoteReserve = 1_000_000_000n // == threshold, no migrated flag
    await assert.rejects(
      prepareTradeQuote({ poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' }, null, makeDeps()),
      (err: unknown) => {
        assert.ok(err instanceof PoolNotTradeableError)
        assert.equal(err.status, 409)
        assert.equal(err.migrationState, 'migration_pending')
        assert.equal(err.fields.retryable, true)
        return true
      },
    )
    assert.equal(swapQuoteCalls.length + swapQuote2Calls.length, 0)
    assert.equal(swapCalls.length + swap2Calls.length, 0)
  })

  it('migrated refuses toward Jupiter — non-retryable, never migration_pending', async () => {
    mockIsMigrated = 1
    mockMigrationProgress = 3
    mockQuoteReserve = 0n // drained reserves must not fake an active curve
    await assert.rejects(
      prepareTradeTx(
        {
          poolAddress: POOL_ADDRESS,
          ownerPublicKey: OWNER_ADDRESS,
          side: 'buy',
          amountIn: '100',
        },
        null,
        makeDeps(),
      ),
      (err: unknown) => {
        assert.ok(err instanceof PoolNotTradeableError)
        assert.equal(err.migrationState, 'migrated')
        assert.equal(err.fields.retryable, false)
        return true
      },
    )
    assert.equal(swapQuoteCalls.length + swapQuote2Calls.length, 0)
    assert.equal(swapCalls.length + swap2Calls.length, 0)
  })
})

// ─── Trade geo (D5: buy and sell resolve identically) ────────────────────────
describe('trade geo gate', () => {
  it('idea coin + restricted idea.trade refuses with geo_restricted', async () => {
    mockLaunchType = 'idea'
    mockGeo = { region: 'US', restricted: ['idea.trade'] }
    await assert.rejects(
      prepareTradeQuote({ poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' }, '1.2.3.4', makeDeps()),
      (err: unknown) => {
        assert.ok(err instanceof GeoRestrictedError)
        assert.equal(err.status, 403)
        assert.equal(err.fields.error, 'geo_restricted')
        assert.equal(err.fields.feature, 'idea.trade')
        assert.equal(err.fields.region, 'US')
        assert.equal(err.fields.regionName, 'United States')
        assert.equal(err.fields.message, 'This is not currently available in United States (US).')
        return true
      },
    )
    assert.equal(swapQuote2Calls.length, 0, 'no quote ran past the gate')
  })

  it('startup coin + restricted startup.trade refuses on SELL identically', async () => {
    mockLaunchType = 'startup'
    mockGeo = { region: 'GB', restricted: ['startup.trade'] }
    await assert.rejects(
      prepareTradeQuote({ poolAddress: POOL_ADDRESS, side: 'sell', amountIn: '100' }, null, makeDeps()),
      (err: unknown) => {
        assert.ok(err instanceof GeoRestrictedError)
        assert.equal(err.fields.feature, 'startup.trade')
        return true
      },
    )
  })

  it('memecoin trading is never gated — even with all trade keys restricted', async () => {
    mockLaunchType = 'meme'
    mockGeo = {
      region: 'US',
      restricted: ['idea.trade', 'startup.trade', 'stock.trade'],
    }
    const result = await prepareTradeQuote(
      { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' },
      null,
      makeDeps(),
    )
    assert.equal(result.amountOut, '900000')
  })

  it('a backend metadata miss resolves the category via the served config options', async () => {
    metadataFetchThrows = true
    mockOptions = { idea: [{ configKey: CONFIG_ADDRESS }] }
    mockGeo = { region: 'US', restricted: ['idea.trade'] }
    await assert.rejects(
      prepareTradeQuote({ poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' }, null, makeDeps()),
      (err: unknown) => {
        assert.ok(err instanceof GeoRestrictedError)
        assert.equal(err.fields.feature, 'idea.trade')
        return true
      },
    )
  })

  it('stock-quoted coins are gated by stock.trade even when the category is open', async () => {
    mockQuoteMint = STOCK_QUOTE_MINT
    mockQuoteAssets = [
      {
        mint: STOCK_QUOTE_MINT,
        symbol: 'GOOGLx',
        decimals: 8,
        tokenProgram: TOKEN_2022,
      },
    ]
    mockGeo = { region: 'US', restricted: ['stock.trade'] }
    await assert.rejects(
      prepareTradeQuote({ poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' }, null, makeDeps()),
      (err: unknown) => {
        assert.ok(err instanceof GeoRestrictedError)
        assert.equal(err.fields.feature, 'stock.trade')
        return true
      },
    )
  })

  it('a stock-quoted coin trades when stock.trade is NOT restricted', async () => {
    mockQuoteMint = STOCK_QUOTE_MINT
    mockQuoteAssets = [
      { mint: STOCK_QUOTE_MINT, symbol: 'GOOGLx', decimals: 8, tokenProgram: TOKEN_2022 },
    ]
    const result = await prepareTradeQuote(
      { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' },
      null,
      makeDeps(),
    )
    assert.equal(result.poolInfo.quoteMint, STOCK_QUOTE_MINT)
    assert.equal(result.poolInfo.quoteSymbol, 'GOOGLx')
  })

  it('SOL quote mint (built-in SPL) is never treated as stock', async () => {
    mockQuoteAssets = [{ mint: QUOTE_MINT, symbol: 'SOL', decimals: 9, tokenProgram: SPL_TOKEN }]
    mockGeo = { region: 'US', restricted: ['stock.trade'] }
    const result = await prepareTradeQuote(
      { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' },
      null,
      makeDeps(),
    )
    assert.equal(result.poolInfo.quoteMint, QUOTE_MINT)
  })
})

// ─── Client IP forwarding ────────────────────────────────────────────────────
describe('mobile-config fetch', () => {
  it('forwards the caller IP to mobile-config on every request', async () => {
    const seen: (string | null)[] = []
    const deps = makeDeps()
    deps.catalogDeps = {
      fetchMobileConfig: async (clientIp) => {
        seen.push(clientIp)
        return { cluster: 'mainnet-beta', geo: { region: null, restricted: [] } }
      },
    }
    await prepareTradeQuote(
      { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '100' },
      '198.51.100.9',
      deps,
    )
    assert.deepEqual(seen, ['198.51.100.9'])
  })
})
