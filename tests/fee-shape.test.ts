/**
 * Fee-shape decode unit tests. The live fixture covers the decay curve;
 * market-cap-decay/preset shapes exercise the same decoder on crafted inputs
 * mirroring the app's test cases (no RPC involvement — this is pure decode
 * logic over the decoded account object).
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  decodeLaunchFeeShape,
  decodeMigratedPoolBaseFeeBytes,
  formatFeePercent,
  isCauseOnlyFeeConfig,
  isDonationRoutingCapable,
  launchFeeLabel,
} from '../src/lib/launch-fee-options.ts'
import {
  decodePoolConfigFixture,
  DONATION_CLAIM_AUTHORITY,
  LIVE_CONFIG_ACCOUNT,
} from './helpers.ts'

describe('decodeLaunchFeeShape (real fixture)', () => {
  it('decodes the default config: 98.86%→1.25% time decay, dynamic fee off, 125bps post, 30% creator', async () => {
    const config = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
    const shape = decodeLaunchFeeShape(config)
    assert.deepEqual(shape.curve, {
      kind: 'decay',
      startFeeBps: 9886,
      endFeeBps: 125,
      periods: 20,
      periodLength: 75,
      // activationType 0 → the 75-unit period is SLOTS (~0.4s each): the
      // anti-sniper window is ~10 min, not 25.
      periodUnit: 'slots',
    })
    assert.equal(shape.curveDynamicFee, false)
    assert.deepEqual(shape.postGraduation, { kind: 'flat', feeBps: 125 })
    assert.equal(shape.creatorTradingFeePercentage, 30)
    const label = launchFeeLabel(shape)
    assert.match(label, /98\.86% → 1\.25%/)
    assert.match(label, /anti-sniper ~10 min/)
  })
})

describe('decodePostGradFeeShape via decodeLaunchFeeShape', () => {
  const baseConfig = {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: '50000000', // 5%
        firstFactor: 0,
        secondFactor: '0',
        thirdFactor: '0',
        baseFeeMode: 0,
      },
      dynamicFee: { initialized: 0 },
    },
    creatorTradingFeePercentage: 50,
  }

  it('migrationFeeOption presets read the fixed tier table, never migratedPoolFee* zeros', () => {
    for (const [option, bps] of [[0, 25], [1, 30], [2, 100], [5, 600]] as const) {
      const shape = decodeLaunchFeeShape({ ...baseConfig, migrationFeeOption: option })
      assert.deepEqual(shape.postGraduation, { kind: 'flat', feeBps: bps })
    }
  })

  it('option 6 + mode 0 + zero scheduler bytes → flat migratedPoolFeeBps', () => {
    const shape = decodeLaunchFeeShape({
      ...baseConfig,
      migrationFeeOption: 6,
      migratedPoolFeeBps: 125,
      migratedPoolBaseFeeMode: 0,
      migratedPoolBaseFeeBytes: new Array(16).fill(0),
    })
    assert.deepEqual(shape.postGraduation, { kind: 'flat', feeBps: 125 })
  })

  it('option 6 + mode 3 + decoded scheduler bytes → marketCapDecay with computed floor', () => {
    // u16 numberOfPeriod=4, u16 sqrtPriceStepBps=0, u32 duration=0,
    // u64 reductionFactor=1_000_000 → floor = 125*1e5 − 4*1e6 over 1e5 → 85bps.
    const bytes = new Uint8Array(16)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 4, true)
    view.setBigUint64(8, 1_000_000n, true)
    const shape = decodeLaunchFeeShape({
      ...baseConfig,
      migrationFeeOption: 6,
      migratedPoolFeeBps: 125,
      migratedPoolBaseFeeMode: 3,
      migratedPoolBaseFeeBytes: bytes,
    })
    assert.deepEqual(shape.postGraduation, {
      kind: 'marketCapDecay',
      startFeeBps: 125,
      endFeeBps: 85,
    })
  })

  it('undecodable fields degrade to custom/null', () => {
    const shape = decodeLaunchFeeShape({})
    assert.equal(shape.curve.kind, 'custom')
    assert.equal(shape.curveDynamicFee, null)
    assert.equal(shape.postGraduation.kind, 'custom')
    assert.equal(shape.creatorTradingFeePercentage, null)
    assert.equal(launchFeeLabel(shape), 'Custom fee')
  })

  it("decodes the new tiers' exponential window (mode 1) to the tier's whole bps", () => {
    // dbc-config antiSniperBaseFee (2026-10-20): 99% × (1 − 1963/1e4)^20 = 1.2517%,
    // (1 − 1386/1e4)^20 → 5.0088%, (1 − 1083/1e4)^20 → 10.0002%.
    for (const [thirdFactor, endFeeBps] of [['1963', 125], ['1386', 500], ['1083', 1000]] as const) {
      const shape = decodeLaunchFeeShape({
        activationType: 0,
        poolFees: { baseFee: { cliffFeeNumerator: '990000000', firstFactor: 20, secondFactor: '75', thirdFactor, baseFeeMode: 1 } },
      })
      assert.deepEqual(shape.curve, {
        kind: 'decay', startFeeBps: 9900, endFeeBps, periods: 20, periodLength: 75, periodUnit: 'slots',
      })
    }
  })
})

describe('decodeMigratedPoolBaseFeeBytes', () => {
  it('parses the LE struct and rejects malformed input', () => {
    const bytes = new Uint8Array(16)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 7, true)
    view.setUint16(2, 30, true)
    view.setUint32(4, 86400, true)
    view.setBigUint64(8, 999n, true)
    const params = decodeMigratedPoolBaseFeeBytes(bytes)
    assert.deepEqual(params, {
      numberOfPeriod: 7,
      sqrtPriceStepBps: 30,
      schedulerExpirationDuration: 86400,
      reductionFactor: 999n,
    })
    assert.equal(decodeMigratedPoolBaseFeeBytes([1, 2, 3]), null)
    assert.equal(decodeMigratedPoolBaseFeeBytes('zz'), null)
    assert.equal(decodeMigratedPoolBaseFeeBytes(null), null)
  })
})

describe('donation routing + cause-only', () => {
  it('isDonationRoutingCapable fails closed both directions', () => {
    assert.equal(isDonationRoutingCapable(DONATION_CLAIM_AUTHORITY, [DONATION_CLAIM_AUTHORITY]), true)
    assert.equal(isDonationRoutingCapable(DONATION_CLAIM_AUTHORITY, []), false)
    assert.equal(isDonationRoutingCapable(null, [DONATION_CLAIM_AUTHORITY]), false)
    assert.equal(isDonationRoutingCapable('SomeOtherKey1111111111111111111111111111', [DONATION_CLAIM_AUTHORITY]), false)
  })

  it('isCauseOnlyFeeConfig = share 0 AND capable', () => {
    const shape = { curve: { kind: 'flat', feeBps: 500 }, curveDynamicFee: false, postGraduation: { kind: 'flat', feeBps: 500 }, creatorTradingFeePercentage: 0 } as const
    assert.equal(isCauseOnlyFeeConfig(shape, true), true)
    assert.equal(isCauseOnlyFeeConfig(shape, false), false)
    assert.equal(isCauseOnlyFeeConfig({ ...shape, creatorTradingFeePercentage: 1 }, true), false)
    assert.equal(isCauseOnlyFeeConfig(null, true), false)
  })
})

describe('formatFeePercent', () => {
  it('trims trailing zeros', () => {
    assert.equal(formatFeePercent(500), '5')
    assert.equal(formatFeePercent(95), '0.95')
    assert.equal(formatFeePercent(125), '1.25')
    assert.equal(formatFeePercent(9900), '99')
  })
})
