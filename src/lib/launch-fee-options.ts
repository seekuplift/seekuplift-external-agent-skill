/**
 * Launch fee-shape decode — ported from the app's
 * src/domain/launch-fee-options.ts (FC-APP-1). Each config's economics are
 * labelled from the DECODED live pool config, never from env names or backend
 * fields. A config we cannot decode gets a generic "custom fee" shape —
 * never an invented one.
 *
 * The app emits i18n copy descriptors; this service emits the resolved
 * English strings (the app's en.ts templates) since agents consume JSON.
 */
import { toBigIntish, toFiniteNumber } from './dbc-shared.ts'

/** DBC `poolFees.baseFee.baseFeeMode === 0` (FeeSchedulerLinear). */
const CURVE_BASE_FEE_MODE_LINEAR = 0
/** DAMM v2 `migratedPoolBaseFeeMode` 0 (time scheduler) + all-zero scheduler bytes = flat. */
const MIGRATED_POOL_BASE_FEE_MODE_FLAT = 0
/** DAMM v2 `migratedPoolBaseFeeMode` 3 = market-cap fee scheduler. */
const MIGRATED_POOL_BASE_FEE_MODE_MARKET_CAP = 3
/** `migrationFeeOption` 6 = Customizable (reads the migratedPoolFee* fields). */
const MIGRATION_FEE_OPTION_CUSTOMIZABLE = 6
/** `migrationFeeOption` 0–5 are fixed DAMM v2 preset tiers (bps). The
 *  migratedPoolFee* fields stay ZERO on these configs — zeros there are NOT a
 *  0% fee. The live SKR configs are option 0 = 25 bps (0.25%). */
const MIGRATION_FEE_OPTION_PRESET_BPS = [25, 30, 100, 200, 400, 600] as const
/** Anchor LE layout of `migratedPoolBaseFeeBytes`
 *  (MigratedPoolMarketCapFeeSchedulerParams {u16, u16, u32, u64}). */
const MIGRATED_POOL_BASE_FEE_BYTES_LEN = 16
const FEE_NUMERATOR_DENOMINATOR = 1_000_000_000n
/** bps ↔ numerator conversion: bps = numerator * 1e4 / 1e9 = numerator / 1e5. */
const BPS_PER_NUMERATOR_STEP = 100_000n
/**
 * DAMM v2 takes a 20% protocol cut on migrated-pool trading fees; the
 * remaining 80% accrues to the locked positions. Napkin-math only for the
 * creator-share line; never a settlement number.
 */
const MIGRATED_POOL_POST_PROTOCOL_FRACTION = 0.8

/** Bonding-curve fee shape, decoded from `poolFees.baseFee`. */
export type CurveFeeShape =
  /** Flat BASE fee — `baseFeeMode` 0 AND every scheduler factor zero.
   *  The curve's dynamic volatility fee may still apply on top. */
  | { kind: 'flat'; feeBps: number }
  /** Linear launch decay — cliff fee stepping down over `firstFactor` periods.
   *  `periodLength` is the scheduler's `secondFactor`, expressed in the
   *  config's `periodUnit` (`activationType` 0 → slots, 1 → seconds). */
  | {
      kind: 'decay'
      startFeeBps: number
      endFeeBps: number
      periods: number
      periodLength: number
      periodUnit: 'slots' | 'seconds' | null
    }
  | { kind: 'custom' }

/** Post-graduation (DAMM v2) fee shape. */
export type PostGradFeeShape =
  | { kind: 'flat'; feeBps: number }
  /** Customizable market-cap scheduler — decays from cliff toward floor as
   *  market cap grows (mode 3 + decoded `migratedPoolBaseFeeBytes`). */
  | { kind: 'marketCapDecay'; startFeeBps: number; endFeeBps: number }
  | { kind: 'custom' }

/**
 * The chain-decoded fee shape of one pool config — the only source the
 * catalog labels from. Fields are `custom`/`null` whenever the live account
 * does not decode far enough; nothing is invented.
 */
export type LaunchFeeShape = {
  curve: CurveFeeShape
  /** Whether the curve's dynamic (volatility) fee is enabled — `true`/`false`
   *  when `poolFees.dynamicFee.initialized` decoded, `null` when absent. */
  curveDynamicFee: boolean | null
  postGraduation: PostGradFeeShape
  /** The config's `creatorTradingFeePercentage` (u8, percent of trading fees
   *  routed to the creator share). `null` when undecoded. */
  creatorTradingFeePercentage: number | null
}

function feeNumeratorToBps(numerator: bigint): number {
  return Number((numerator * 10_000n) / FEE_NUMERATOR_DENOMINATOR)
}

/** Decoded `migratedPoolBaseFeeBytes` scheduler params (LE). */
export type MigratedPoolBaseFeeParams = {
  numberOfPeriod: number
  sqrtPriceStepBps: number
  schedulerExpirationDuration: number
  reductionFactor: bigint
}

/**
 * Decode `migratedPoolBaseFeeBytes` — the Anchor LE serialization of
 * `MigratedPoolMarketCapFeeSchedulerParams {u16 numberOfPeriod,
 * u16 sqrtPriceStepBps, u32 schedulerExpirationDuration, u64 reductionFactor}`
 * (16 bytes). Accepts a `number[]`, `Uint8Array`/`Buffer`, or a hex string.
 * Returns `null` on anything else — the caller labels the config "custom",
 * never guesses.
 */
export function decodeMigratedPoolBaseFeeBytes(bytes: unknown): MigratedPoolBaseFeeParams | null {
  let arr: number[] | null = null
  if (Array.isArray(bytes)) {
    arr = bytes
  } else if (bytes instanceof Uint8Array) {
    arr = Array.from(bytes)
  } else if (typeof bytes === 'string' && bytes.trim()) {
    const trimmed = bytes.trim()
    if (/^(0x)?[0-9a-fA-F]+$/.test(trimmed)) {
      const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed
      arr = []
      for (let i = 0; i < hex.length; i += 2) arr.push(parseInt(hex.slice(i, i + 2), 16))
    }
  }
  if (
    !arr ||
    arr.length !== MIGRATED_POOL_BASE_FEE_BYTES_LEN ||
    arr.some((b) => !Number.isInteger(b) || b < 0 || b > 255)
  ) {
    return null
  }
  const view = new DataView(Uint8Array.from(arr).buffer)
  return {
    numberOfPeriod: view.getUint16(0, true),
    sqrtPriceStepBps: view.getUint16(2, true),
    schedulerExpirationDuration: view.getUint32(4, true),
    reductionFactor: view.getBigUint64(8, true),
  }
}

function isZeroSchedulerParams(params: MigratedPoolBaseFeeParams): boolean {
  return (
    params.numberOfPeriod === 0 &&
    params.sqrtPriceStepBps === 0 &&
    params.schedulerExpirationDuration === 0 &&
    params.reductionFactor === 0n
  )
}

/**
 * Bonding-curve phase: `poolFees.baseFee`. `baseFeeMode` 0 is
 * FeeSchedulerLinear for BOTH shapes — the market-cap config keeps the shared
 * anti-snipe launch decay (non-zero factors), while the flat configs are flat
 * only because every scheduler factor is zero. So "flat" = mode 0 AND
 * `firstFactor`/`secondFactor`/`thirdFactor` all 0; rate =
 * `cliffFeeNumerator / 1e9`. `baseFeeMode` 0 alone never means flat.
 */
function decodeCurveFeeShape(baseFee: unknown, activationType: number | null): CurveFeeShape {
  if (!baseFee || typeof baseFee !== 'object') return { kind: 'custom' }
  const bf = baseFee as {
    cliffFeeNumerator?: unknown
    firstFactor?: unknown
    secondFactor?: unknown
    thirdFactor?: unknown
    baseFeeMode?: unknown
  }
  const cliff = toBigIntish(bf.cliffFeeNumerator)
  const mode = toFiniteNumber(bf.baseFeeMode)
  if (cliff == null || cliff < 0n || mode == null) return { kind: 'custom' }
  if (mode !== CURVE_BASE_FEE_MODE_LINEAR) return { kind: 'custom' }
  const firstFactor = toFiniteNumber(bf.firstFactor)
  const secondFactor = toBigIntish(bf.secondFactor)
  const thirdFactor = toBigIntish(bf.thirdFactor)
  if (firstFactor == null || secondFactor == null || thirdFactor == null) {
    return { kind: 'custom' }
  }
  if (firstFactor === 0 && secondFactor === 0n && thirdFactor === 0n) {
    return { kind: 'flat', feeBps: feeNumeratorToBps(cliff) }
  }
  // Linear decay: fee steps down by `thirdFactor` (reductionFactor) each of
  // `firstFactor` periods. End numerator = cliff − reduction × periods.
  if (firstFactor > 0 && thirdFactor > 0n) {
    const endNumerator = cliff - thirdFactor * BigInt(Math.trunc(firstFactor))
    return {
      kind: 'decay',
      startFeeBps: feeNumeratorToBps(cliff),
      endFeeBps: feeNumeratorToBps(endNumerator > 0n ? endNumerator : 0n),
      periods: Math.trunc(firstFactor),
      // secondFactor is the scheduler's per-period duration in the
      // config's activation unit (slots when activationType=0).
      periodLength: Number(secondFactor),
      periodUnit: activationType === 0 ? 'slots' : activationType === 1 ? 'seconds' : null,
    }
  }
  return { kind: 'custom' }
}

/**
 * Post-graduation phase: `migrationFeeOption` decides which fields are live.
 * Options 0–5 are preset DAMM v2 tiers that leave every `migratedPoolFee*`
 * field ZERO — those zeros are NOT a 0% fee. Only option 6 (Customizable)
 * reads `migratedPoolFeeBps` + `migratedPoolBaseFeeMode`: mode 0 with an
 * all-zero `migratedPoolBaseFeeBytes` → flat; mode 3 → market-cap decay with
 * the floor computed from the decoded scheduler bytes.
 */
function decodePostGradFeeShape(config: {
  migrationFeeOption?: unknown
  migratedPoolFeeBps?: unknown
  migratedPoolBaseFeeMode?: unknown
  migratedPoolBaseFeeBytes?: unknown
}): PostGradFeeShape {
  const option = toFiniteNumber(config.migrationFeeOption)
  if (option == null || !Number.isInteger(option) || option < 0) return { kind: 'custom' }
  if (option < MIGRATION_FEE_OPTION_CUSTOMIZABLE) {
    return { kind: 'flat', feeBps: MIGRATION_FEE_OPTION_PRESET_BPS[option] }
  }
  if (option !== MIGRATION_FEE_OPTION_CUSTOMIZABLE) return { kind: 'custom' }

  const feeBps = toFiniteNumber(config.migratedPoolFeeBps)
  const mode = toFiniteNumber(config.migratedPoolBaseFeeMode)
  if (feeBps == null || mode == null || feeBps < 0) return { kind: 'custom' }
  const params = decodeMigratedPoolBaseFeeBytes(config.migratedPoolBaseFeeBytes)
  if (mode === MIGRATED_POOL_BASE_FEE_MODE_FLAT) {
    if (params && isZeroSchedulerParams(params)) return { kind: 'flat', feeBps }
    return { kind: 'custom' }
  }
  if (mode === MIGRATED_POOL_BASE_FEE_MODE_MARKET_CAP) {
    if (!params || params.numberOfPeriod <= 0 || params.reductionFactor <= 0n) {
      return { kind: 'custom' }
    }
    // Floor numerator = cliff*1e5 − reductionFactor*numberOfPeriod over 1e9
    // (the cp-amm market-cap scheduler's ending base fee).
    const floorNumerator =
      BigInt(Math.trunc(feeBps)) * BPS_PER_NUMERATOR_STEP -
      params.reductionFactor * BigInt(params.numberOfPeriod)
    const endFeeBps = floorNumerator > 0n ? Number(floorNumerator / BPS_PER_NUMERATOR_STEP) : 0
    return { kind: 'marketCapDecay', startFeeBps: feeBps, endFeeBps }
  }
  return { kind: 'custom' }
}

/**
 * Decode the fee-relevant shape of a live DBC `PoolConfig` (the SDK
 * `getPoolConfig` result — `unwrapConfig` already applied by the caller).
 * Never throws; every undecodable piece degrades to `custom`/`null`.
 */
export function decodeLaunchFeeShape(config: unknown): LaunchFeeShape {
  const rec = (config ?? {}) as {
    poolFees?: {
      baseFee?: unknown
      dynamicFee?: { initialized?: unknown; isInitialized?: unknown }
    }
    activationType?: unknown
    migrationFeeOption?: unknown
    migratedPoolFeeBps?: unknown
    migratedPoolBaseFeeMode?: unknown
    migratedPoolBaseFeeBytes?: unknown
    creatorTradingFeePercentage?: unknown
  }
  const dynamicInitialized = rec.poolFees?.dynamicFee?.initialized ?? rec.poolFees?.dynamicFee?.isInitialized
  const creatorPct = toFiniteNumber(rec.creatorTradingFeePercentage)
  const activationType = toFiniteNumber(rec.activationType)
  return {
    curve: decodeCurveFeeShape(rec.poolFees?.baseFee, activationType ?? null),
    curveDynamicFee: dynamicInitialized == null ? null : !!toFiniteNumber(dynamicInitialized),
    postGraduation: decodePostGradFeeShape(rec),
    creatorTradingFeePercentage:
      creatorPct != null && creatorPct >= 0 && creatorPct <= 100 ? creatorPct : null,
  }
}

/** bps → a trimmed percent string: 500 → "5", 95 → "0.95", 125 → "1.25". */
export function formatFeePercent(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return '?'
  return (bps / 100).toFixed(3).replace(/\.?0+$/, '')
}

/**
 * Creator-share napkin math: the creator position's share of each
 * post-graduation trade, in bps of trade volume =
 * `feeBps × (1 − 20% protocol cut) × creatorTradingFeePercentage`.
 */
export function creatorShareOfTradeVolumeBps(
  postGradFeeBps: number,
  creatorTradingFeePercentage: number,
): number {
  if (!Number.isFinite(postGradFeeBps) || postGradFeeBps <= 0) return 0
  return (postGradFeeBps * MIGRATED_POOL_POST_PROTOCOL_FRACTION * creatorTradingFeePercentage) / 100
}

/**
 * Whether an option is a cause-only config: the DECODED creator share is
 * exactly 0% AND the live `feeClaimer` is a configured donation claim
 * authority. Every fee left after Meteora's protocol cut then goes to the
 * cause. Chain-derived like every other fee label — never inferred from the
 * option slug.
 */
export function isCauseOnlyFeeConfig(
  shape: LaunchFeeShape | null | undefined,
  donationRoutingCapable: boolean,
): boolean {
  return donationRoutingCapable && shape?.creatorTradingFeePercentage === 0
}

/**
 * Whether a launch on this config can actually route donations: the live
 * pool-config's `feeClaimer` must be one of the configured donation claim
 * authorities. Fail-closed in both directions: an undecoded feeClaimer
 * (`null`) or a missing authority list is NOT capable.
 */
export function isDonationRoutingCapable(
  feeClaimer: string | null | undefined,
  donationClaimAuthorities: readonly string[] | null | undefined,
): boolean {
  const claimer = feeClaimer?.trim()
  return (
    !!claimer &&
    (donationClaimAuthorities ?? []).some((expected) => expected.trim() === claimer)
  )
}

// ─── Human-readable labels (app en.ts templates, resolved) ─────────────────────

/** Approximate seconds per decay period (~0.4s/slot when slot-activated). */
const SLOT_SECONDS_ESTIMATE = (unit: 'slots' | 'seconds' | null): number =>
  unit === 'slots' ? 0.4 : 1

function phaseEndBps(phase: CurveFeeShape | PostGradFeeShape): number | null {
  if (phase.kind === 'flat') return phase.feeBps
  if (phase.kind === 'decay' || phase.kind === 'marketCapDecay') return phase.endFeeBps
  return null
}

/**
 * One-line fee summary for the catalog entry — the chip label plus the
 * anti-sniper detail: a decaying curve reads e.g. "99% → 1.25% (anti-sniper
 * ~25 min), then 0.25% after graduation".
 */
export function launchFeeLabel(shape: LaunchFeeShape | null, causeOnly = false): string {
  const suffix = causeOnly ? ' · all to cause' : ''
  if (!shape || shape.curve.kind === 'custom' || shape.postGraduation.kind === 'custom') {
    return `Custom fee${suffix}`
  }
  const curve = shape.curve
  const post = shape.postGraduation
  const curvePart =
    curve.kind === 'flat'
      ? `${formatFeePercent(curve.feeBps)}%`
      : curve.kind === 'decay'
        ? `${formatFeePercent(curve.startFeeBps)}% → ${formatFeePercent(curve.endFeeBps)}%`
        : 'custom'
  const postPart =
    post.kind === 'flat'
      ? `${formatFeePercent(post.feeBps)}%`
      : post.kind === 'marketCapDecay'
        ? `${formatFeePercent(post.startFeeBps)}% → ${formatFeePercent(post.endFeeBps)}%`
        : 'custom'
  if (
    curve.kind === 'flat' &&
    post.kind === 'flat' &&
    curve.feeBps === post.feeBps
  ) {
    return `Flat ${curvePart}${suffix}`
  }
  const decayNote =
    curve.kind === 'decay'
      ? ` (anti-sniper ~${Math.max(
          1,
          Math.round(
            (curve.periods * curve.periodLength * SLOT_SECONDS_ESTIMATE(curve.periodUnit)) / 60,
          ),
        )} min)`
      : ''
  return `${curvePart}${decayNote}, then ${postPart} after graduation${suffix}`
}

/**
 * Detail lines for one option — the resolved English strings behind the
 * app's `launchFeeDetailDescriptors` templates: bonding-curve phase, the
 * volatility-fee note when the curve's dynamic fee is on, post-graduation
 * phase, the factual creator-share napkin line, and for a cause-only config
 * the all-to-cause line.
 */
export function launchFeeDetailLines(shape: LaunchFeeShape | null, causeOnly = false): string[] {
  if (!shape) {
    return [
      "This option's fee schedule could not be decoded — verify it on-chain before launch.",
    ]
  }
  const lines: string[] = []

  const curve = shape.curve
  if (curve.kind === 'flat') {
    lines.push(`Bonding curve: ${formatFeePercent(curve.feeBps)}% base fee on every trade`)
  } else if (curve.kind === 'decay') {
    lines.push(
      `Bonding curve: starts at ${formatFeePercent(curve.startFeeBps)}% base fee, decays to ${formatFeePercent(curve.endFeeBps)}%`,
    )
  } else {
    lines.push('Bonding curve: custom fee schedule')
  }

  if (shape.curveDynamicFee === true) {
    lines.push('A volatility fee can add to the curve fee during sharp price moves.')
  }

  const post = shape.postGraduation
  if (post.kind === 'flat') {
    lines.push(`After graduation: ${formatFeePercent(post.feeBps)}% fee on every trade`)
  } else if (post.kind === 'marketCapDecay') {
    lines.push(
      `After graduation: ${formatFeePercent(post.startFeeBps)}% fee, decaying to ${formatFeePercent(post.endFeeBps)}% as market cap grows`,
    )
  } else {
    lines.push('After graduation: custom fee schedule')
  }

  const creatorPct = shape.creatorTradingFeePercentage
  if (creatorPct != null) {
    if (post.kind === 'flat') {
      const share = creatorShareOfTradeVolumeBps(post.feeBps, creatorPct)
      if (share > 0) {
        lines.push(
          `Creator share of that fee: ≈${formatFeePercent(share)}% of each post-graduation trade`,
        )
      }
    } else if (post.kind === 'marketCapDecay') {
      const lo = creatorShareOfTradeVolumeBps(post.endFeeBps, creatorPct)
      const hi = creatorShareOfTradeVolumeBps(post.startFeeBps, creatorPct)
      if (hi > 0) {
        lines.push(
          `Creator share of that fee: ≈${formatFeePercent(lo)}–${formatFeePercent(hi)}% of each post-graduation trade`,
        )
      }
    }
  }
  if (causeOnly) {
    lines.push("No creator share: every fee left after Meteora's protocol cut goes to the cause.")
  }
  return lines
}
