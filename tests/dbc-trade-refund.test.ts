/**
 * DBC-RF-1 service regressions: gross consumed input + gross refund against
 * the REAL installed DBC SDK quote/fee/curve math — a direct port of the
 * app's `dbc-swap-client-refund.test.mjs` to this service's `deps.client`
 * seam (an `OfflineClient` subclassing the real SDK client; every fee, curve
 * and quote function stays installed SDK 1.5.13 code — a preselected mocked
 * `amountLeft` pass-through cannot satisfy these tests).
 *
 * Fixture: the recorded `61UBwyZf` SKR testing curve + fee schedule from the
 * app's audit (`docs/math/dbc-regular-swap-fees-audit-gpt-6-astra.verify.mjs`)
 * — synthetic pool state over recorded config values, not a live snapshot.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/dbc-trade-refund.test.ts
 */
import { strict as assert } from 'node:assert'
import { after, describe, mock, test } from 'node:test'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Connection, PublicKey } from '@solana/web3.js'
import {
  DynamicBondingCurveClient,
  SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { fetchDbcSwapQuote } from '../src/lib/dbc-trade.ts'

// Pin the SDK whose math these expectations were derived from (same pin as
// the app test).
assert.equal(
  JSON.parse(
    readFileSync(
      new URL('../node_modules/@meteora-ag/dynamic-bonding-curve-sdk/package.json', import.meta.url),
      'utf8',
    ),
  ).version,
  '1.5.13',
)

const bn = (x: bigint | number | string) => new BN(String(x))
const bi = (x: { toString(): string }) => BigInt(x.toString())
const hex = (x: string) => new BN(x, 16)

// Recorded 61UBwyZf curve and fee config; pool state is synthetic.
const config = {
  activationType: 0,
  collectFeeMode: 0,
  // TF-APP-1: SPL Token base mint — the quote path provably skips the
  // transfer-fee mint read for tokenType 0, keeping this fixture offline.
  tokenType: 0,
  enableFirstSwapWithMinFee: 1,
  sqrtStartPrice: hex('000944a821c8c30f'),
  migrationSqrtPrice: hex('012515fdab8464d9'),
  migrationQuoteThreshold: hex('0000248aaf38'),
  curve: [
    { sqrtPrice: hex('012515fdab8464d9'), liquidity: hex('0020f5ceb9555958970df504bea4') },
    { sqrtPrice: hex('fffec4b1845c1aa94e69579b'), liquidity: hex('03719d55dc1d2c1e563d4b') },
  ],
  poolFees: {
    baseFee: {
      baseFeeMode: 0,
      cliffFeeNumerator: bn(990000000),
      firstFactor: 20,
      secondFactor: bn(75),
      thirdFactor: bn(48875000),
    },
    dynamicFee: {
      initialized: 1,
      binStep: 1,
      binStepU128: hex('068db8bac710cb'),
      filterPeriod: 10,
      decayPeriod: 120,
      reductionFactor: 5000,
      variableFeeControl: 1195,
      maxVolatilityAccumulator: bn(14460000),
    },
  },
}
const key = new PublicKey('61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv')
const pool = {
  config: key,
  sqrtPrice: config.sqrtStartPrice,
  quoteReserve: bn(0),
  activationPoint: bn(100000),
  volatilityTracker: { volatilityAccumulator: bn(0) },
}
let slot = 100000

// Only state/RPC reads are replaced. Every quote/fee/curve method remains
// installed SDK code.
const connection = new Connection('http://127.0.0.1:1')
const realClient = new DynamicBondingCurveClient(connection, 'confirmed')
class OfflineClient extends DynamicBondingCurveClient {
  constructor(...args: ConstructorParameters<typeof DynamicBondingCurveClient>) {
    super(...args)
    const state = this.state as unknown as Record<string, unknown>
    state.getPool = async () => pool
    state.getPoolConfig = async () => config
  }
}
const offlineClient = new OfflineClient(connection, 'confirmed')
mock.method(Connection.prototype, 'getSlot', async () => slot)
after(() => mock.restoreAll())

/** Set one synthetic fee/state point, mirroring the audit fixture. */
function setPoint(point: {
  elapsed: number
  volatility: bigint
  mode: number
  sell: boolean
}) {
  slot = 100000 + point.elapsed
  pool.volatilityTracker.volatilityAccumulator = bn(point.volatility)
  config.collectFeeMode = point.mode
  pool.sqrtPrice = point.sell ? config.sqrtStartPrice.muln(2) : config.sqrtStartPrice
}

/** Quote through the service AND the real SDK pool method, returning both. */
async function quoteBoth(sell: boolean, input: bigint) {
  const args = {
    virtualPool: { poolState: pool },
    config,
    swapBaseForQuote: sell,
    amountIn: bn(input),
    slippageBps: 50,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: bn(slot),
  }
  const expected = sell
    ? realClient.pool.swapQuote(args as never)
    : realClient.pool.swapQuote2({ ...args, swapMode: SwapMode.PartialFill } as never)
  const actual = await fetchDbcSwapQuote(
    { poolAddress: key.toString(), swapBaseForQuote: sell, amountIn: input },
    { connection, client: offlineClient },
  )
  return { expected, actual }
}

/**
 * The DBC-RF-1 contract assertions for one quote: exact output/minimum,
 * gross consumed input, gross refund, raw net remainder, and the integer
 * conservation invariant.
 */
function assertRefundContract(
  sell: boolean,
  input: bigint,
  expected: unknown,
  actual: {
    amountOut: bigint
    minimumAmountOut: bigint
    consumedInput: bigint
    amountLeft: bigint
    amountLeftNet: bigint
  },
) {
  const e = expected as Record<string, { toString(): string } | undefined>
  // The sell path (`swapQuote` → `getSwapResult`) returns neither
  // `includedFeeInputAmount` nor `amountLeft`: an ExactIn full fill consumes
  // the whole request by construction. Mirror the client's fallback here so
  // the assertions below pin that behavior instead of crashing on it.
  const expectedConsumed =
    e.includedFeeInputAmount != null ? bi(e.includedFeeInputAmount) : input
  const expectedNet = e.amountLeft != null ? bi(e.amountLeft) : 0n
  assert.equal(actual.amountOut, bi(e.outputAmount!), 'output must match the real SDK exactly')
  assert.equal(
    actual.minimumAmountOut,
    (bi(e.outputAmount!) * 9950n) / 10000n,
    'minimum must be output less 50 bps',
  )
  assert.equal(actual.consumedInput, expectedConsumed, 'consumedInput = SDK includedFeeInputAmount')
  assert.equal(actual.amountLeft, input - expectedConsumed, 'gross refund = requested − consumed')
  assert.equal(actual.amountLeftNet, expectedNet, 'raw SDK remainder preserved separately')
  assert.equal(actual.consumedInput + actual.amountLeft, input, 'consumed + refund conserve')
  if (!sell && config.collectFeeMode === 0 && expectedNet > 0n) {
    // The bug shape: with input fees the raw remainder is net, so the gross
    // refund is never below it (fee monotonicity over gross amounts; equality
    // only at single-atom remainders where ceil quantization absorbs the fee).
    assert.ok(actual.amountLeft >= actual.amountLeftNet, 'gross refund covers the net remainder')
  }
  if (sell || expectedNet === 0n) {
    assert.equal(actual.amountLeft, 0n, 'full fills and sells refund nothing')
    assert.equal(actual.consumedInput, input, 'full fills and sells consume the whole request')
  }
}

describe('DBC-RF-1 audit fixture (SKR curve, ending base fee, zero volatility)', () => {
  test('1000 SKR buy: consumed 620,828,963, refund 379,171,037 (not net 374,431,400)', async () => {
    setPoint({ elapsed: 1500, volatility: 0n, mode: 0, sell: false })
    const input = 1_000_000_000n
    const { expected, actual } = await quoteBoth(false, input)
    assertRefundContract(false, input, expected, actual)
    assert.equal(actual.consumedInput, 620_828_963n)
    assert.equal(actual.amountLeft, 379_171_037n)
    assert.equal(actual.amountLeftNet, 374_431_400n)
    assert.equal(actual.amountLeft - actual.amountLeftNet, 4_739_637n, 'refund understatement the bug caused')
    assert.equal(Number(actual.consumedInput) / 1e6, 620.828963)
    assert.equal(Number(input - actual.amountLeft) / 1e6, 620.828963)
  })

  test('capacity ±1 atom around the ending-fee crossing point', async () => {
    setPoint({ elapsed: 1500, volatility: 0n, mode: 0, sell: false })
    for (const input of [620_828_962n, 620_828_963n, 620_828_964n]) {
      const { expected, actual } = await quoteBoth(false, input)
      assertRefundContract(false, input, expected, actual)
    }
  })
})

describe('DBC-RF-1 real-SDK matrix (input/output fees × buy/sell × fee states)', () => {
  const elapsedSlots = [0, 75, 1500, 10000]
  const volatilities = [0n, 1n, 1234567n, 14460000n]
  const buyInputs = [
    1_000_000n,
    100_000_000n,
    1_000_000_000n,
    100_000_000_000n,
    9_007_199_254_740_993n,
  ]
  const sellInputs = [1_000_000n, 100_000_000n]

  for (const elapsed of elapsedSlots) {
    for (const volatility of volatilities) {
      for (const mode of [0, 1]) {
        const label =
          `elapsed=${elapsed} vol=${volatility} ` + `mode=${mode === 0 ? 'input-fee' : 'output-fee'}`
        test(`buys: ${label}`, async () => {
          setPoint({ elapsed, volatility, mode, sell: false })
          for (const input of buyInputs) {
            const { expected, actual } = await quoteBoth(false, input)
            assertRefundContract(false, input, expected, actual)
          }
        })
        test(`sells: ${label}`, async () => {
          setPoint({ elapsed, volatility, mode, sell: true })
          for (const input of sellInputs) {
            const { expected, actual } = await quoteBoth(true, input)
            assertRefundContract(true, input, expected, actual)
          }
        })
      }
    }
  }

  test('amounts above Number.MAX_SAFE_INTEGER stay atom-exact', async () => {
    setPoint({ elapsed: 1500, volatility: 0n, mode: 0, sell: false })
    const input = 9_007_199_254_740_993n // MAX_SAFE_INTEGER + 2
    assert.ok(input > BigInt(Number.MAX_SAFE_INTEGER))
    const { expected, actual } = await quoteBoth(false, input)
    assertRefundContract(false, input, expected, actual)
    assert.equal(String(actual.consumedInput + actual.amountLeft), String(input))
  })
})
