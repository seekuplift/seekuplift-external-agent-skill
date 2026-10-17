/**
 * Shared Solana/DBC plumbing for the agent API.
 *
 * Split out of the old single `dbc.ts`: this module carries everything the
 * launch module (`./dbc-launch.ts`), the trade module (`./dbc-trade.ts`) and
 * the config catalog (`./config-catalog.ts`) share —
 *   - the RPC connection and decoded-account helpers (`getPoolAndConfig`,
 *     `fetchPoolConfigData`, `unwrapConfig`, `extractFeeClaimer`, the
 *     `toBigIntish`/`toFiniteNumber` normalizers);
 *   - mint reads (`fetchMintDecimals`, `readMintTokenInfo` with the
 *     Token-2022 ScaledUiAmount extension parse);
 *   - the compute-budget / priority-fee helpers ported from the app
 *     (priority-fee.ts + compute-budget.ts: simulate x1.3 limit, p75 price
 *     with the app's floor/cap, lamport-budget cap, apply pair).
 *
 * Ported from launchpad-mobile-redesign/src/services/{dbc-launch-client,
 * compute-budget,priority-fee}.ts and src/domain/scaled-ui-amount.ts,
 * adapted to web3.js v1 on Node.
 */
import BN from 'bn.js'
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import {
  DynamicBondingCurveClient,
  type VirtualPool,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { RPC_URL } from './config.ts'
import {
  parseTransferFeeConfig,
  parseTransferFeeConfigFromRaw,
  type MintTransferFeeConfig,
} from './transfer-fee.ts'

export function toBN(value: bigint): BN {
  return new BN(value.toString())
}

// ─── Connection / client ───────────────────────────────────────────────────────

let cachedConnection: Connection | null = null

export function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(RPC_URL, 'confirmed')
  }
  return cachedConnection
}

/** Test seam: drop the memoized connection. */
export function resetConnectionForTests(): void {
  cachedConnection = null
}

export function getDbcClient(): DynamicBondingCurveClient {
  return new DynamicBondingCurveClient(getConnection(), 'confirmed')
}

/** Inner pool-state struct; `getPool` returns it wrapped in `{ poolState }`. */
export type VirtualPoolState = VirtualPool extends { poolState: infer S }
  ? S
  : VirtualPool

/**
 * Tolerant unwrap of a decoded `virtualPool` account — mirrors the app's
 * dbc-swap-client (`record.poolState ?? rawPool`).
 */
export function unwrapPoolState(raw: unknown): VirtualPoolState {
  const rec = raw as { poolState?: unknown }
  return (rec?.poolState ?? raw) as VirtualPoolState
}

export async function getPoolAndConfig(
  client: DynamicBondingCurveClient,
  poolAddress: string,
): Promise<{
  virtualPool: VirtualPool
  poolState: VirtualPoolState
  config: PoolConfig
  /** The pool address the state was read under (echoed for the callers' result shapes). */
  poolAddress: string
}> {
  // An existing account owned by something else (a wallet, a mint, another
  // program's state) fails the Anchor decode — that is "no pool here" too.
  const virtualPool = await client.state.getPool(new PublicKey(poolAddress)).catch((err) => {
    if (/Invalid account discriminator/.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  })
  if (!virtualPool) throw new Error(`DBC pool not found: ${poolAddress}`)
  const poolState = unwrapPoolState(virtualPool)
  const config = await client.state.getPoolConfig(poolState.config)
  if (!config) throw new Error(`DBC pool config not found for pool: ${poolAddress}`)
  return { virtualPool, poolState, config, poolAddress }
}

// ─── Pool-config decode helpers ────────────────────────────────────────────────
// Mirrors the app's tolerant decoders (dbc-launch-client.ts): every field is
// `unknown` in, `null` out on anything undecodable — fail closed, never guess.

/**
 * `getPoolConfig` returns the PoolConfig directly, or the config of a
 * `configWithTransferHook` account ({ config }) on the fallback leg.
 */
export function unwrapConfig(raw: unknown): Record<string, unknown> {
  const rec = raw as { config?: unknown; poolConfig?: unknown }
  return (rec?.config ?? rec?.poolConfig ?? raw ?? {}) as Record<string, unknown>
}

/**
 * Normalize a decoded pool config's `feeClaimer` to a base58 string. Null
 * when the field is absent or cannot be normalized — the cause gate treats
 * null as not-capable, never as a wildcard.
 */
export function extractFeeClaimer(config: {
  feeClaimer?: unknown
  fee_claimer?: unknown
}): string | null {
  const raw = config.feeClaimer ?? config.fee_claimer
  if (raw == null) return null
  if (typeof raw === 'string') return raw.trim() || null
  if (typeof raw === 'object') {
    const rec = raw as { toBase58?: () => string; toString?: () => string }
    if (typeof rec.toBase58 === 'function') {
      const value = rec.toBase58().trim()
      if (value) return value
    }
    if (typeof rec.toString === 'function') {
      const value = rec.toString().trim()
      if (value) return value
    }
  }
  return null
}

/**
 * Thrown when an SDK quote result lacks the fields the callers read. A
 * renamed/removed field must fail loudly — never degrade to a zero quote
 * that builds an unprotected or mis-sized transaction.
 */
export class DbcQuoteShapeError extends Error {
  constructor(detail: string) {
    super(`Unexpected DBC quote result shape: ${detail}`)
    this.name = 'DbcQuoteShapeError'
  }
}

/**
 * The quote's output atoms from an SDK swap-quote result. The SDK has used
 * both `outputAmount` (current) and `amountOut` (older shape); when NEITHER
 * is present the result is unrecognized and throws — a missing field used
 * to fall through to `'0'`, which read as a legitimate zero quote.
 */
export function quoteAmountOut(result: Record<string, unknown> | null | undefined): bigint {
  const raw = result?.outputAmount ?? result?.amountOut
  if (raw == null) {
    throw new DbcQuoteShapeError('neither outputAmount nor amountOut is present')
  }
  const amount = toBigIntish(raw)
  if (amount == null) {
    throw new DbcQuoteShapeError(`unparseable output amount: ${String(raw)}`)
  }
  return amount
}

export function toBigIntish(value: unknown): bigint | null {
  if (value == null) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value)
    } catch {
      return null
    }
  }
  if (typeof value === 'object' && 'toString' in value) {
    try {
      return BigInt((value as { toString(): string }).toString())
    } catch {
      return null
    }
  }
  return null
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? asNumber : null
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'object' && value != null && 'toNumber' in value) {
    try {
      const parsed = (value as { toNumber(): number }).toNumber()
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Decoded DBC pool-config account for `configKey`, or null when the account
 * does not exist or cannot be decoded. The caller decides whether that is
 * fatal (launch) or a degraded entry (catalog).
 */
export async function fetchPoolConfigData(
  configKey: string,
): Promise<Record<string, unknown> | null> {
  const client = getDbcClient()
  const raw = await client.state.getPoolConfig(new PublicKey(configKey))
  if (raw == null) return null
  return unwrapConfig(raw)
}

// ─── Mint reads ────────────────────────────────────────────────────────────────

export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

export async function fetchMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(mint, 'confirmed')
  const decimals = info?.data?.[44]
  if (typeof decimals === 'number') return decimals
  throw new Error(`Cannot resolve decimals for mint ${mint.toString()}`)
}

/** Token-2022 extension id for ScaledUiAmountConfig. */
const SCALED_UI_AMOUNT_EXTENSION_TYPE = 25
/** Byte offset where mint TLV entries begin: 165-byte base account + 1-byte account type. */
const MINT_TLV_OFFSET = 166
const TLV_HEADER_SIZE = 4
/** scaledUiAmountConfig payload: authority (32) + multiplier f64 + effective ts i64 + newMultiplier f64. */
const SCALED_UI_AMOUNT_VALUE_SIZE = 56

/**
 * The mint's scaling configuration as decimal strings, exactly as RPC reports
 * them. `null` config anywhere means multiplier 1 (SPL Token mints and
 * Token-2022 mints without the extension).
 */
export type ScaledUiAmountConfig = {
  /** Currently-published multiplier, decimal string. */
  multiplier: string
  /** Scheduled multiplier that takes over at `newMultiplierEffectiveTimestamp`. */
  newMultiplier: string
  /** Unix seconds at which `newMultiplier` becomes effective. */
  newMultiplierEffectiveTimestamp: number
}

/** A multiplier as an exact rational: `numerator / denominator`. */
export type ScaledUiMultiplier = {
  numerator: bigint
  denominator: bigint
}

export const IDENTITY_SCALED_UI_MULTIPLIER: ScaledUiMultiplier = { numerator: 1n, denominator: 1n }

/**
 * Parse a decimal-string multiplier into an exact rational. Anything
 * non-positive or unparseable yields null — callers treat null as 1, so a
 * malformed config degrades to unscaled rather than inventing a factor.
 */
export function parseScaledUiMultiplier(value: unknown): ScaledUiMultiplier | null {
  const str =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : ''
  if (!/^\d+(\.\d+)?$/.test(str)) return null
  const [whole, fraction = ''] = str.split('.')
  try {
    const numerator = BigInt(whole) * 10n ** BigInt(fraction.length) + BigInt(fraction || '0')
    const denominator = 10n ** BigInt(fraction.length)
    if (numerator <= 0n) return null
    return { numerator, denominator }
  } catch {
    return null
  }
}

/**
 * The multiplier in effect at `nowUnixSec` — `newMultiplier` at or after
 * `newMultiplierEffectiveTimestamp`, `multiplier` before it. A null/absent or
 * unparseable config yields the identity (multiplier 1).
 */
export function effectiveScaledUiMultiplier(
  config: ScaledUiAmountConfig | null | undefined,
  nowUnixSec: number = Math.floor(Date.now() / 1000),
): ScaledUiMultiplier {
  if (!config) return IDENTITY_SCALED_UI_MULTIPLIER
  const ts = config.newMultiplierEffectiveTimestamp
  const useNew = Number.isFinite(ts) && nowUnixSec >= ts
  const parsed = parseScaledUiMultiplier(useNew ? config.newMultiplier : config.multiplier)
  return parsed ?? IDENTITY_SCALED_UI_MULTIPLIER
}

/**
 * Thrown when a mint carries the ScaledUiAmount extension but its multiplier
 * cannot be decoded. Fail closed: treating it as 1 would mis-size amounts.
 */
export class ScaledUiDecodeError extends Error {
  constructor(detail: string) {
    super(`ScaledUiAmount extension present but undecodable: ${detail}`)
    this.name = 'ScaledUiDecodeError'
  }
}

/** f64 -> plain decimal string (never exponent notation, which the parser rejects). */
function formatF64Decimal(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
}

/** Only called when the extension IS present; throws if the multiplier is undecodable. */
function normalizeScaledUiConfig(input: {
  multiplier?: unknown
  newMultiplier?: unknown
  newMultiplierEffectiveTimestamp?: unknown
}): ScaledUiAmountConfig {
  const multiplier = parseScaledUiMultiplier(input.multiplier)
  if (!multiplier) throw new ScaledUiDecodeError(`multiplier ${String(input.multiplier)}`)
  const newMultiplier = parseScaledUiMultiplier(input.newMultiplier)
  const ts = Number(input.newMultiplierEffectiveTimestamp)
  return {
    multiplier: String(input.multiplier),
    newMultiplier: newMultiplier ? String(input.newMultiplier) : String(input.multiplier),
    newMultiplierEffectiveTimestamp:
      newMultiplier && Number.isFinite(ts) && ts >= 0 ? Math.trunc(ts) : Number.MAX_SAFE_INTEGER,
  }
}

/**
 * Tolerant parse of the `scaledUiAmountConfig` extension out of a
 * `getParsedAccountInfo` mint `data` field.
 */
export function parseScaledUiAmountConfig(accountData: unknown): ScaledUiAmountConfig | null {
  if (!accountData || typeof accountData !== 'object') return null
  const extensions = (accountData as {
    parsed?: { info?: { extensions?: unknown[] } }
  }).parsed?.info?.extensions
  if (!Array.isArray(extensions)) return null
  const state = extensions
    .map((entry) => (entry as { extension?: unknown; state?: unknown } | null))
    .find((entry) => entry?.extension === 'scaledUiAmountConfig')?.state as
    | { multiplier?: unknown; newMultiplier?: unknown; newMultiplierEffectiveTimestamp?: unknown }
    | undefined
  if (!state) return null
  return normalizeScaledUiConfig(state)
}

/**
 * Same config decoded from a RAW mint account (`getAccountInfo` bytes).
 * Token-2022 mints are padded to the 165-byte base account plus a 1-byte
 * account-type discriminator, then TLV entries of `[u16 type][u16 len][data]`
 * — extension 25's 56-byte value is `authority(32) | multiplier f64 |
 * newMultiplierEffectiveTimestamp i64 | newMultiplier f64`. A plain SPL
 * mint (82 bytes, no TLV region) or any malformed layout yields null.
 */
export function parseScaledUiAmountConfigFromRaw(
  data: Uint8Array | null | undefined,
): ScaledUiAmountConfig | null {
  if (!data || data.length <= MINT_TLV_OFFSET) return null
  let offset = MINT_TLV_OFFSET
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  while (offset + TLV_HEADER_SIZE <= buf.length) {
    const entryType = buf.readUInt16LE(offset)
    const entryLen = buf.readUInt16LE(offset + 2)
    offset += TLV_HEADER_SIZE
    if (offset + entryLen > buf.length) return null
    if (entryType === SCALED_UI_AMOUNT_EXTENSION_TYPE) {
      if (entryLen !== SCALED_UI_AMOUNT_VALUE_SIZE) {
        throw new ScaledUiDecodeError(`unexpected extension length ${entryLen}`)
      }
      const multiplier = buf.readDoubleLE(offset + 32)
      const ts = buf.readBigInt64LE(offset + 40)
      const newMultiplier = buf.readDoubleLE(offset + 48)
      return normalizeScaledUiConfig({
        multiplier: formatF64Decimal(multiplier),
        newMultiplier: formatF64Decimal(newMultiplier),
        newMultiplierEffectiveTimestamp: Number(ts),
      })
    }
    offset += entryLen
  }
  return null
}

type MintReader = {
  getParsedAccountInfo(
    pk: PublicKey,
    commitment?: 'confirmed',
  ): Promise<{ value: { data?: unknown; owner?: unknown } | null }>
  getAccountInfo(
    pk: PublicKey,
    commitment?: 'confirmed',
  ): Promise<{ data?: Buffer | Uint8Array | null; owner?: unknown } | null>
}

/**
 * Read a mint's decimals, token program (account owner), scaled-UI config
 * and transfer-fee config in one pass. Parsed form is preferred; the raw
 * account is only consulted when the parsed response was unusable.
 * `decimals`/`tokenProgram` may stay null when neither response decodes —
 * callers decide whether that is fatal for their flow.
 */
export async function readMintTokenInfo(
  connection: MintReader,
  mint: PublicKey,
): Promise<{
  decimals: number | null
  tokenProgram: string | null
  scaledUiAmount: ScaledUiAmountConfig | null
  transferFee: MintTransferFeeConfig | null
}> {
  const parsed = await connection.getParsedAccountInfo(mint, 'confirmed')
  const data = parsed.value?.data
  if (data && typeof data === 'object' && 'parsed' in data) {
    const info = (data as { parsed?: { info?: { decimals?: unknown } } }).parsed?.info
    const decimals =
      typeof info?.decimals === 'number' && Number.isInteger(info.decimals) ? info.decimals : null
    const owner = parsed.value?.owner
    return {
      decimals,
      tokenProgram: typeof owner === 'string' && owner ? owner : String(owner ?? '') || null,
      scaledUiAmount: parseScaledUiAmountConfig(data),
      transferFee: parseTransferFeeConfig(data),
    }
  }
  const raw = await connection.getAccountInfo(mint, 'confirmed')
  const bytes = raw?.data ?? null
  if (!bytes)
    return { decimals: null, tokenProgram: null, scaledUiAmount: null, transferFee: null }
  const decimals = bytes.length > 44 ? bytes[44] : null
  const rawOwner = raw?.owner
  return {
    decimals: typeof decimals === 'number' ? decimals : null,
    tokenProgram:
      typeof rawOwner === 'string' && rawOwner
        ? rawOwner
        : typeof rawOwner === 'object' && rawOwner != null && 'toBase58' in rawOwner
          ? (rawOwner as { toBase58(): string }).toBase58()
          : null,
    scaledUiAmount: parseScaledUiAmountConfigFromRaw(bytes),
    transferFee: parseTransferFeeConfigFromRaw(bytes),
  }
}

// ─── Compute budget / priority fee (app parity: priority-fee.ts + compute-budget.ts) ──

/**
 * App-wide priority-fee hard cap (~0.0001 SOL), in lamports. Also the budget
 * behind `capMicroLamportsByFeeBudget`.
 */
export const MAX_PRIORITY_FEE_LAMPORTS = 100_000

/** Lower clamp for the estimated price, in micro-lamports per CU. */
export const PRIORITY_FEE_FLOOR_MICRO_LAMPORTS = 1_000

/** Upper clamp for the estimated price, in micro-lamports per CU. */
export const PRIORITY_FEE_CEILING_MICRO_LAMPORTS = 2_000_000

/** Bound on each RPC call these estimators make. */
export const FEE_ESTIMATION_TIMEOUT_MS = 5_000

/** Protocol maximum for a requested compute-unit limit. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000

/** Nearest-rank percentile of an already ascending-sorted sample. */
function percentileNearestRank(sortedAscending: number[], p: number): number {
  const rank = Math.ceil(p * sortedAscending.length)
  return sortedAscending[Math.min(Math.max(rank, 1), sortedAscending.length) - 1]
}

/** Promise.race with a timeout, minus the stray timer. */
function withTimeout<T>(value: T | Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC call timed out after ${ms}ms`)), ms)
    Promise.resolve(value).then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Estimated priority-fee price in micro-lamports per CU: the p75 (nearest
 * rank) of the NON-ZERO fees `getRecentPrioritizationFees` reports for the
 * passed writable accounts, clamped to
 * [PRIORITY_FEE_FLOOR_MICRO_LAMPORTS, PRIORITY_FEE_CEILING_MICRO_LAMPORTS].
 * Never throws: any failure returns the floor so the transaction still
 * carries a non-zero price.
 */
export async function estimateComputeUnitPrice(
  connection: Connection,
  writableAccounts: PublicKey[],
): Promise<number> {
  try {
    const fees = await withTimeout(
      connection.getRecentPrioritizationFees({
        lockedWritableAccounts: writableAccounts,
      }),
      FEE_ESTIMATION_TIMEOUT_MS,
    )
    const nonZeroFees = fees
      .map((entry) => entry.prioritizationFee)
      .filter((fee) => fee > 0)
      .sort((a, b) => a - b)
    if (nonZeroFees.length === 0) {
      return PRIORITY_FEE_FLOOR_MICRO_LAMPORTS
    }
    const p75 = percentileNearestRank(nonZeroFees, 0.75)
    return Math.min(
      PRIORITY_FEE_CEILING_MICRO_LAMPORTS,
      Math.max(PRIORITY_FEE_FLOOR_MICRO_LAMPORTS, p75),
    )
  } catch {
    return PRIORITY_FEE_FLOOR_MICRO_LAMPORTS
  }
}

export interface EstimateComputeUnitLimitOptions {
  /** Static worst-case CU limit returned when the simulation cannot run. */
  fallback: number
  /** Multiplier applied to the simulated consumption. Default 1.3. */
  headroom?: number
  /** Lower clamp on the returned limit. Default 5,000. */
  min?: number
}

/**
 * Compute-unit limit for a legacy transaction, from simulation:
 * `max(min, ceil(unitsConsumed × headroom))`, clamped to 1,400,000. Returns
 * `fallback` on simulation error/timeout/failed simulation/missing
 * unitsConsumed. Never throws.
 */
export async function estimateComputeUnitLimit(
  connection: Connection,
  tx: Transaction,
  { fallback, headroom = 1.3, min = 5_000 }: EstimateComputeUnitLimitOptions,
): Promise<number> {
  try {
    const result = await withTimeout(connection.simulateTransaction(tx), FEE_ESTIMATION_TIMEOUT_MS)
    const unitsConsumed = result.value.unitsConsumed
    if (result.value.err != null || unitsConsumed == null) {
      return fallback
    }
    return Math.min(MAX_COMPUTE_UNIT_LIMIT, Math.max(min, Math.ceil(unitsConsumed * headroom)))
  } catch {
    return fallback
  }
}

/**
 * Cap by lamports: `min(estimate, floor(MAX_PRIORITY_FEE_LAMPORTS × 1e6 / units))`
 * so `price × units / 1e6 <= MAX_PRIORITY_FEE_LAMPORTS` always holds.
 */
export function capMicroLamportsByFeeBudget(estimate: number, units: number): number {
  if (units <= 0) {
    return estimate
  }
  return Math.min(estimate, Math.floor((MAX_PRIORITY_FEE_LAMPORTS * 1e6) / units))
}

export interface ComputeBudgetParams {
  units: number
  microLamports: number
}

/**
 * Prepends `setComputeUnitLimit` then `setComputeUnitPrice` to `tx` as its
 * first two instructions, in place. No-op-safe: if `tx` already carries any
 * ComputeBudget instruction the call skips.
 */
export function applyComputeBudget(tx: Transaction, { units, microLamports }: ComputeBudgetParams): void {
  const alreadyBudgeted = tx.instructions.some((ix) =>
    ix.programId.equals(ComputeBudgetProgram.programId),
  )
  if (alreadyBudgeted) {
    return
  }
  tx.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...tx.instructions,
  ]
}

/**
 * The transaction's own writable account keys: the fee payer plus every
 * instruction key flagged writable, de-duplicated in first-encounter order.
 */
export function writableAccountKeys(tx: Transaction): PublicKey[] {
  const seen = new Set<string>()
  const keys: PublicKey[] = []
  const push = (pubkey: PublicKey): void => {
    const encoded = pubkey.toString()
    if (!seen.has(encoded)) {
      seen.add(encoded)
      keys.push(pubkey)
    }
  }
  if (tx.feePayer) push(tx.feePayer)
  for (const ix of tx.instructions) {
    for (const key of ix.keys) {
      if (key.isWritable) push(key.pubkey)
    }
  }
  return keys
}

/**
 * Give a built legacy transaction its compute budget: a CU limit from
 * `estimateComputeUnitLimit` and a price from `estimateComputeUnitPrice`
 * capped by `capMicroLamportsByFeeBudget`, applied via `applyComputeBudget`.
 * Never throws: a failed estimate still applies the fallback limit at the
 * (possibly capped) floor price.
 */
export async function applyEstimatedComputeBudget(
  connection: Connection,
  tx: Transaction,
  fallback: number,
): Promise<void> {
  const [limit, price] = await Promise.all([
    estimateComputeUnitLimit(connection, tx, { fallback }),
    estimateComputeUnitPrice(connection, writableAccountKeys(tx)),
  ])
  applyComputeBudget(tx, {
    units: limit,
    microLamports: capMicroLamportsByFeeBudget(price, limit),
  })
}
