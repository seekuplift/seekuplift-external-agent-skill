/**
 * TF-APP-1: Token-2022 transfer-fee handling for DBC quotes — ported verbatim
 * from the app's `src/domain/transfer-fee.ts`.
 *
 * A launch's base mint may carry the `transferFeeConfig` extension: every
 * transfer withholds `ceil(amount × bps / 10_000)` atoms (capped at
 * `maximumFee`) in the RECEIVING account, so the DBC curve never sees the fee —
 * the vault→trader transfer on a buy delivers `output − fee`, and the
 * trader→vault transfer on a sell lands `amountIn − fee`. DBC 0.2.2 checks
 * `minimum_amount_out` on the fee-EXCLUDED output and `maximum_amount_in` on
 * the fee-INCLUDED input, so quoting the SDK on the raw amounts both
 * over-reports "You receive" and reverts at ordinary slippage settings.
 *
 * Everything here is integer-atom math on the mint's own extension state —
 * never backend prices. The basis to apply is selected by the CURRENT epoch:
 * Token-2022 keeps an `olderTransferFee`/`newerTransferFee` pair and applies
 * `newer` once `epoch >= newerTransferFee.epoch` (the same rule spl-token's
 * `getEpochFee` implements).
 *
 * Quote-mint transfer fees are unsupported by this effort (the backend
 * quarantines such pools) — callers must fail closed rather than quote them.
 */

/** Token-2022 extension id for TransferFeeConfig. */
const TRANSFER_FEE_CONFIG_EXTENSION_TYPE = 1
/** Byte offset where mint TLV entries begin: 165-byte base account + 1-byte account type. */
const MINT_TLV_OFFSET = 166
const TLV_HEADER_SIZE = 4
/**
 * TransferFeeConfig payload: transferFeeConfigAuthority OptionalNonZeroPubkey
 * (32) + withdrawWithheldAuthority (32) + withheldAmount u64 (8) +
 * olderTransferFee (epoch u64 + maximumFee u64 + bps u16 = 18) +
 * newerTransferFee (18) = 108 bytes (`TransferFeeConfigLayout.span`).
 */
const TRANSFER_FEE_CONFIG_VALUE_SIZE = 108
const TRANSFER_FEE_ENTRY_OFFSET = 72 // 32 + 32 + 8 — the two authorities + withheld
const U64_MAX = (1n << 64n) - 1n
const BASIS_POINTS_DENOMINATOR = 10_000n

/** One epoch-gated fee entry from the mint's transferFeeConfig. */
export type TransferFeeBasis = {
  /** First epoch at which this entry applies (u64 on chain). */
  epoch: bigint
  /** Per-transfer fee cap in atoms (u64 on chain). */
  maximumFee: bigint
  /** Fee rate in basis points (u16 on chain, 0–10_000). */
  transferFeeBasisPoints: number
}

/** The mint's two-slot fee schedule, exactly as the extension stores it. */
export type MintTransferFeeConfig = {
  olderTransferFee: TransferFeeBasis
  newerTransferFee: TransferFeeBasis
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    // jsonParsed renders u64 fields as f64 — values beyond 2^53 (e.g. a
    // u64::MAX maximumFee rendered as 18446744073709552000) lose precision.
    // Clamping to u64::MAX keeps the cap exact where it matters: the fee can
    // never exceed the transferred amount, so an over-large cap is inert.
    const truncated = BigInt(Math.trunc(value))
    return truncated > U64_MAX ? U64_MAX : truncated
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    try {
      return BigInt(value)
    } catch {
      return null
    }
  }
  return null
}

function normalizeBasis(raw: unknown): TransferFeeBasis | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as {
    epoch?: unknown
    maximumFee?: unknown
    transferFeeBasisPoints?: unknown
  }
  const epoch = toBigInt(record.epoch)
  const maximumFee = toBigInt(record.maximumFee)
  const bps = Number(record.transferFeeBasisPoints)
  if (
    epoch == null ||
    epoch < 0n ||
    maximumFee == null ||
    maximumFee < 0n ||
    !Number.isInteger(bps) ||
    bps < 0
  )
    return null
  return { epoch, maximumFee, transferFeeBasisPoints: bps }
}

/**
 * Tolerant parse of the `transferFeeConfig` extension out of a
 * `getParsedAccountInfo` mint `data` field — same convention as
 * `parseScaledUiAmountConfig`. Returns null when the extension is absent or
 * its entries are unusable (callers then quote fee-free, which is correct for
 * a mint that genuinely has no fee; an undecodable mint fails earlier on the
 * decimals read).
 */
export function parseTransferFeeConfig(accountData: unknown): MintTransferFeeConfig | null {
  if (!accountData || typeof accountData !== 'object') return null
  const extensions = (
    accountData as {
      parsed?: { info?: { extensions?: unknown[] } }
    }
  ).parsed?.info?.extensions
  if (!Array.isArray(extensions)) return null
  const state = extensions
    .map((entry) => (entry as { extension?: unknown; state?: unknown } | null))
    .find((entry) => entry?.extension === 'transferFeeConfig')?.state as
    | { olderTransferFee?: unknown; newerTransferFee?: unknown }
    | undefined
  if (!state) return null
  const olderTransferFee = normalizeBasis(state.olderTransferFee)
  const newerTransferFee = normalizeBasis(state.newerTransferFee)
  if (!olderTransferFee || !newerTransferFee) return null
  return { olderTransferFee, newerTransferFee }
}

/**
 * Same config decoded from a RAW mint account (`getAccountInfo` bytes):
 * Token-2022 mints are the 165-byte base account + 1-byte account type, then
 * TLV entries `[u16 type][u16 len][data]`; extension 1's 108-byte value is
 * `authority(32) | withdrawAuthority(32) | withheld u64 | older(18) | newer(18)`.
 * Returns null for a plain SPL mint or any malformed layout.
 */
export function parseTransferFeeConfigFromRaw(
  data: Uint8Array | null | undefined,
): MintTransferFeeConfig | null {
  if (!data || data.length <= MINT_TLV_OFFSET) return null
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let offset = MINT_TLV_OFFSET
  while (offset + TLV_HEADER_SIZE <= buf.length) {
    const entryType = buf.readUInt16LE(offset)
    const entryLen = buf.readUInt16LE(offset + 2)
    offset += TLV_HEADER_SIZE
    if (offset + entryLen > buf.length) return null
    if (entryType === TRANSFER_FEE_CONFIG_EXTENSION_TYPE) {
      if (entryLen !== TRANSFER_FEE_CONFIG_VALUE_SIZE) return null
      const entry = (at: number): TransferFeeBasis => ({
        epoch: buf.readBigUInt64LE(at),
        maximumFee: buf.readBigUInt64LE(at + 8),
        transferFeeBasisPoints: buf.readUInt16LE(at + 16),
      })
      return {
        olderTransferFee: entry(offset + TRANSFER_FEE_ENTRY_OFFSET),
        newerTransferFee: entry(offset + TRANSFER_FEE_ENTRY_OFFSET + 18),
      }
    }
    offset += entryLen
  }
  return null
}

/**
 * Whether the mint charges (or is scheduled to charge) a transfer fee: either
 * epoch slot has a non-zero rate.
 */
export function hasTransferFee(config: MintTransferFeeConfig | null | undefined): boolean {
  return (
    config != null &&
    (config.olderTransferFee.transferFeeBasisPoints > 0 ||
      config.newerTransferFee.transferFeeBasisPoints > 0)
  )
}

/**
 * The fee basis in effect at `epoch`: `newer` once `epoch >= newer.epoch`,
 * `older` before that — the same rule spl-token's `getEpochFee` implements.
 */
export function transferFeeBasisForEpoch(
  config: MintTransferFeeConfig,
  epoch: bigint,
): TransferFeeBasis {
  return epoch >= config.newerTransferFee.epoch ? config.newerTransferFee : config.olderTransferFee
}

/**
 * The fee Token-2022 withholds on a transfer of `amount` atoms:
 * `ceil(amount × bps / 10_000)` capped at `maximumFee`, never exceeding the
 * amount itself (a pathological >100% basis is treated as total withholding).
 * Matches the fixture captures exactly (TF-DC-1 `run.json`).
 */
export function calculateTransferFeeAtomics(amount: bigint, basis: TransferFeeBasis): bigint {
  if (amount <= 0n) return 0n
  const bps = BigInt(basis.transferFeeBasisPoints)
  const fee = (amount * bps + (BASIS_POINTS_DENOMINATOR - 1n)) / BASIS_POINTS_DENOMINATOR
  const capped = fee < basis.maximumFee ? fee : basis.maximumFee
  return capped < amount ? capped : amount
}

/** The amount that actually lands after the fee: `amount − fee`, floored at 0. */
export function netOfTransferFee(amount: bigint, basis: TransferFeeBasis): bigint {
  return amount - calculateTransferFeeAtomics(amount, basis)
}

/**
 * `minimumAmountOut` derived from a NET output amount under `slippageBps`,
 * mirroring the DBC SDK's formula exactly (`output × (10_000 − bps) / 10_000`,
 * floor). For fee-free mints callers keep the SDK's own `minimumAmountOut` —
 * this exists so a transfer-fee output can be slippage-adjusted AFTER the fee
 * is subtracted, which is what DBC 0.2.2's fee-excluded `minimum_amount_out`
 * check requires.
 */
export function minimumAmountOutWithSlippage(netAmountOut: bigint, slippageBps: number): bigint {
  if (!(slippageBps > 0)) return netAmountOut
  const factor = BigInt(Math.round(10_000 - slippageBps))
  return (netAmountOut * factor) / BASIS_POINTS_DENOMINATOR
}
