/**
 * DBC trade helpers: pool info, swap quotes, swap transaction building.
 *
 * Ported from the app's `src/services/dbc-swap-client.ts` (QA-34 partial-fill
 * buys, TF-APP-1 transfer-fee net/gross handling, DBC-RF-1 gross consumed /
 * refund fields, CA-A-5 `migrationState` routing, ISSUE-002 compute budget),
 * adapted to web3.js v1 on Node. Shared plumbing lives in `./dbc-shared.ts`;
 * the transfer-fee and migration-state domain modules are `./transfer-fee.ts`
 * and `./dbc-migration.ts`.
 *
 *   - Buys (quote → base, `swapBaseForQuote: false`) quote through
 *     `pool.swapQuote2` + `SwapMode.PartialFill` and build through
 *     `pool.swap2` — a threshold-crossing buy consumes only enough quote to
 *     graduate the curve and refunds the remainder, where the full-fill path
 *     would throw `Insufficient Liquidity`.
 *   - Sells (base → quote) stay on the full-fill `swapQuote`/`swap` path.
 *   - Default slippage is 50 bps, same as the app.
 */
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import {
  DynamicBondingCurveClient,
  getCurrentPoint,
  SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT } from './config.ts'
import {
  applyEstimatedComputeBudget,
  getConnection,
  getDbcClient,
  getPoolAndConfig,
  readMintTokenInfo,
  SPL_TOKEN_PROGRAM_ID,
  toBN,
  type ScaledUiAmountConfig,
} from './dbc-shared.ts'
import {
  deriveDbcPoolMigrationState,
  type DbcPoolMigrationState,
} from './dbc-migration.ts'
import {
  calculateTransferFeeAtomics,
  minimumAmountOutWithSlippage,
  transferFeeBasisForEpoch,
  type MintTransferFeeConfig,
} from './transfer-fee.ts'
import {
  resolveQuoteAssetRecord,
  type QuoteAssetRecord,
} from './config-catalog.ts'

const DEFAULT_SLIPPAGE_BPS = 50

/** Test seam — the network-facing collaborators of the trade paths. */
export type TradeClientDeps = {
  connection?: Connection
  client?: DynamicBondingCurveClient
  /**
   * Backend-served `quoteAssets` (from mobile-config) layered over the
   * built-in registry — the app's merged quote-asset registry. Omitted →
   * built-ins only.
   */
  quoteAssets?: readonly QuoteAssetRecord[]
}

type DbcPoolState = Awaited<ReturnType<typeof getPoolAndConfig>>

export type DbcPoolInfo = {
  poolAddress: string
  /** The pool's DBC config key — the catalog lookup used for trade geo. */
  configKey: string
  baseMint: string
  baseDecimals: number
  quoteMint: string
  quoteDecimals: number
  quoteSymbol: string
  /**
   * SQ-APP-4: the quote mint's Token-2022 ScaledUiAmount config, read with the
   * pool when the quote mint could carry one (unknown or Token-2022 mints).
   * Null for SPL Token mints and for mints without the extension.
   */
  quoteScaledUiAmount: ScaledUiAmountConfig | null
  /**
   * TF-APP-1: the base mint's Token-2022 `transferFeeConfig` extension (both
   * epoch entries; epoch selection happens at quote time). `null` when the
   * mint carries no fee.
   */
  baseTransferFee: MintTransferFeeConfig | null
  isQuoteSol: boolean
  quoteReserve: bigint
  migrationQuoteThreshold: bigint
  /**
   * CA-A-5: the pool's explicit migration state — `curve | migration_pending
   * | migrated` — derived from the on-chain `isMigrated`/`migrationProgress`
   * flags plus the reserve threshold. Route on THIS field: only `curve` may
   * trade on the bonding curve and only `migrated` routes to Jupiter;
   * `migration_pending` is non-tradeable on both.
   */
  migrationState: DbcPoolMigrationState
  /**
   * Curve-unavailable compatibility signal: `migrationState !== "curve"`
   * (pending OR migrated). Deliberately does NOT distinguish "graduated"
   * from "migrating" — routing decisions belong to `migrationState`.
   */
  isCompleted: boolean
}

async function poolInfoFromState(
  connection: Connection,
  state: DbcPoolState,
  quoteAssets?: readonly QuoteAssetRecord[],
): Promise<DbcPoolInfo> {
  const { poolState, config } = state
  const baseMint = poolState.baseMint.toString()
  const quoteMint = config.quoteMint.toString()
  // TF-APP-1: the base mint is always read — it carries the transfer-fee
  // extension this client must quote against, and (when the registry misses)
  // the decimals.
  const baseMintInfo = await readMintTokenInfo(connection, poolState.baseMint)
  const baseDecimals =
    resolveQuoteAssetRecord(baseMint, quoteAssets)?.decimals ?? baseMintInfo.decimals
  if (baseDecimals == null) {
    throw new Error(`Unable to resolve decimals for mint ${baseMint}`)
  }
  const baseTransferFee = baseMintInfo.transferFee
  // SQ-APP-4: read the quote mint account whenever it could carry a
  // scaledUiAmountConfig — registered SPL Token mints cannot (skip the RPC),
  // everything else (Token-2022 stocks, unknown mints needing decimals) gets
  // one mint read for decimals + the config. An unreadable mint fails the
  // pool read rather than silently trading with multiplier 1.
  const quoteRegistered = resolveQuoteAssetRecord(quoteMint, quoteAssets)
  let quoteScaledUiAmount: ScaledUiAmountConfig | null = null
  let quoteDecimals: number | null = quoteRegistered?.decimals ?? null
  if (quoteRegistered?.tokenProgram !== SPL_TOKEN_PROGRAM_ID) {
    const mintInfo = await readMintTokenInfo(connection, config.quoteMint)
    if (mintInfo.decimals == null) {
      // Undecodable mint → we cannot prove it is unscaled; fail closed rather
      // than silently trading with multiplier 1.
      throw new Error(`Unable to resolve mint info for quote mint ${quoteMint}`)
    }
    // TF-APP-1: a transfer fee on the QUOTE mint is unsupported — the quote
    // mint's in/out legs would both be fee-adjusted and neither leg's
    // correction accounts for it. Fail closed rather than quote it wrong
    // (the backend quarantines such pools already).
    if (mintInfo.transferFee) {
      throw new Error(
        `QUOTE_MINT_TRANSFER_FEE_UNSUPPORTED: quote mint ${quoteMint} carries a transfer fee`,
      )
    }
    quoteScaledUiAmount = mintInfo.scaledUiAmount
    quoteDecimals ??= mintInfo.decimals
  }
  if (quoteDecimals == null) {
    throw new Error(`Unable to resolve decimals for mint ${quoteMint}`)
  }
  const quoteReserve = BigInt(poolState.quoteReserve.toString())
  const migrationQuoteThreshold = BigInt(config.migrationQuoteThreshold.toString())
  // CA-A-5: graduation is the pool's OWN migration state, not a reserve
  // comparison — a migrated pool can hold less than the threshold (vaults
  // drained into the DAMM pool) and a full reserve can sit un-migrated
  // while the migration crank has not landed. `isCompleted` stays as the
  // "curve unavailable" compatibility signal (pending OR migrated).
  const migrationState = deriveDbcPoolMigrationState({
    isMigrated: (poolState as { isMigrated?: unknown }).isMigrated,
    migrationProgress: (poolState as { migrationProgress?: unknown }).migrationProgress,
    quoteReserve,
    migrationQuoteThreshold,
  })
  return {
    poolAddress: state.poolAddress,
    configKey: poolState.config.toString(),
    baseMint,
    baseDecimals,
    quoteMint,
    quoteDecimals,
    quoteScaledUiAmount,
    baseTransferFee,
    quoteSymbol:
      quoteRegistered?.symbol ?? `${quoteMint.slice(0, 4)}…${quoteMint.slice(-4)}`,
    isQuoteSol: quoteMint === NATIVE_MINT,
    quoteReserve,
    migrationQuoteThreshold,
    migrationState,
    isCompleted: migrationState !== 'curve',
  }
}

export async function fetchDbcPoolInfo(
  poolAddress: string,
  deps: TradeClientDeps = {},
): Promise<DbcPoolInfo> {
  const connection = deps.connection ?? getConnection()
  const client = deps.client ?? getDbcClient()
  const state = await getPoolAndConfig(client, poolAddress)
  return poolInfoFromState(connection, state, deps.quoteAssets)
}

export type DbcSwapQuoteResult = {
  /**
   * TF-APP-1: NET output atoms the wallet actually receives. On a
   * transfer-fee base mint this is the curve's `outputAmount` minus the fee
   * Token-2022 withholds in the receiving account on the vault→trader
   * transfer (buy), or the curve output computed on the fee-excluded input
   * (sell). Fee-free mints return the SDK value unchanged.
   */
  amountOut: bigint
  /**
   * TF-APP-1: derived from the NET output — DBC 0.2.2 checks
   * `minimum_amount_out` on the fee-excluded amount, so a gross-derived floor
   * would revert whenever the fee exceeds the slippage budget.
   */
  minimumAmountOut: bigint
  /**
   * TF-APP-1: the base-mint transfer fee the quote implies, in base atoms —
   * withheld in the receiving token account on the swap's base leg. `0n` when
   * the mint carries no fee.
   */
  baseTransferFeeAtomics: bigint
  /**
   * DBC-RF-1: gross quote input the bonding-curve quote actually consumed, in
   * atoms — the SDK's `includedFeeInputAmount` from `swapQuote` (sell) or
   * `swapQuote2` PartialFill (buy). For a full fill this equals the requested
   * `amountIn`; for a threshold-crossing partial buy it is the grossed-up
   * consumed net (only `requested - consumed` is refunded).
   */
  consumedInput: bigint
  /**
   * DBC-RF-1: estimated UNCONSUMED gross quote input (refunded to the buyer),
   * in atoms: `requested amountIn − consumedInput`, floored at zero. Only
   * nonzero for buys that cross the migration threshold — PartialFill
   * consumes exactly enough quote to reach the threshold and refunds the
   * remainder. `0n` for sells and for buys that do not cross the threshold.
   *
   * This is a quote ESTIMATE, not a measured post-transaction wallet delta.
   */
  amountLeft: bigint
  /**
   * DBC-RF-1: the SDK's raw `amountLeft` remainder, in atoms, preserved for
   * diagnostics. With input fees this remainder is in NET quote atoms (fee
   * already stripped), so it must never be reported as the refund.
   */
  amountLeftNet: bigint
}

export async function fetchDbcSwapQuote(params: {
  poolAddress: string
  swapBaseForQuote: boolean
  amountIn: bigint
  slippageBps?: number
  /**
   * TF-APP-1: the base mint's transfer-fee config when the caller already
   * read it (e.g. `poolInfo.baseTransferFee`). `undefined` → read the mint
   * here when the token type could carry the extension; `null` → known
   * fee-free. Pass-through only — never invented.
   */
  baseTransferFee?: MintTransferFeeConfig | null
}, deps: TradeClientDeps = {}): Promise<DbcSwapQuoteResult> {
  const {
    poolAddress,
    swapBaseForQuote,
    amountIn,
    slippageBps = DEFAULT_SLIPPAGE_BPS,
    baseTransferFee,
  } = params
  const connection = deps.connection ?? getConnection()
  const client = deps.client ?? getDbcClient()
  const state = await getPoolAndConfig(client, poolAddress)
  return quoteFromState(
    client,
    connection,
    state,
    swapBaseForQuote,
    amountIn,
    slippageBps,
    baseTransferFee,
  )
}

async function quoteFromState(
  client: DynamicBondingCurveClient,
  connection: Connection,
  state: DbcPoolState,
  swapBaseForQuote: boolean,
  amountIn: bigint,
  slippageBps: number,
  baseTransferFee?: MintTransferFeeConfig | null,
): Promise<DbcSwapQuoteResult> {
  const { poolState, config } = state
  const currentPoint = await getCurrentPoint(connection, config.activationType)
  // TF-APP-1: the base mint's transfer fee. `undefined` means the caller did
  // not already read the mint — read it here, but only when the pool's token
  // type could carry the extension: an SPL Token base mint (config.tokenType
  // === 0) provably cannot, so fee-free SPL pools skip the RPC entirely.
  let feeConfig = baseTransferFee
  if (feeConfig === undefined) {
    feeConfig =
      config.tokenType === 0
        ? null
        : (await readMintTokenInfo(connection, poolState.baseMint)).transferFee
  }
  // The fee entry is epoch-gated; Token-2022 switches to newerTransferFee at
  // `newer.epoch`. The epoch read only happens for mints that carry a fee.
  let feeBasis: ReturnType<typeof transferFeeBasisForEpoch> | null = null
  if (feeConfig) {
    const epochInfo = await connection.getEpochInfo('confirmed')
    feeBasis = transferFeeBasisForEpoch(feeConfig, BigInt(epochInfo.epoch))
  }
  // QA-34: DBC `swap`/`swapQuote` are ExactIn full-fill only. A buy (quote →
  // base) that would push the quote reserve past `migrationQuoteThreshold` has
  // no base tokens to fill the whole order, so the full-fill path throws
  // `Insufficient Liquidity` — the curve can never be completed from the app.
  // Buys use `pool.swapQuote2` with `SwapMode.PartialFill`, which consumes only
  // enough quote to reach the threshold and returns the unconsumed remainder.
  // PartialFill degrades to a normal full fill when the order does not cross
  // the threshold, so it is a safe default for every buy. Sells (base → quote)
  // move the reserve away from the threshold and stay on the full-fill
  // `pool.swapQuote` path.
  //
  // DBC-RF-1: with input fees the SDK's `amountLeft` remainder is in NET quote
  // atoms while the request is gross, so `requested − amountLeft` overstates
  // both the refund understatement and the provisional spent quote. The SDK
  // separately returns `includedFeeInputAmount` (gross consumed input); the
  // gross refund is `requested − consumed`, all in integer atoms.
  const poolMethods = client.pool as unknown as {
    swapQuote(args: unknown): Record<string, { toString(): string }>
    swapQuote2(args: unknown): Record<string, { toString(): string }>
  }
  // TF-APP-1: on a sell, the trader→vault transfer withholds the fee in the
  // VAULT, so the curve only ever sees the fee-excluded input — quote the SDK
  // on `amountIn − fee`. The swap instruction itself still takes the gross
  // (fee-included) `amountIn` (DBC 0.2.2 `params.amount_in` semantics), which
  // is what `buildDbcSwapTx` passes — unchanged.
  const inputTransferFee =
    swapBaseForQuote && feeBasis ? calculateTransferFeeAtomics(amountIn, feeBasis) : 0n
  const curveAmountIn = amountIn - inputTransferFee
  const quoteArgs = {
    virtualPool: { poolState } as never,
    config: config as never,
    swapBaseForQuote,
    amountIn: toBN(curveAmountIn),
    slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  }
  const quoteAny = (
    swapBaseForQuote
      ? poolMethods.swapQuote(quoteArgs)
      : poolMethods.swapQuote2({ ...quoteArgs, swapMode: SwapMode.PartialFill })
  ) as Record<string, { toString(): string }>
  // DBC-RF-1: surface gross consumed input and derive the gross refund from
  // it. `includedFeeInputAmount` is present on both SDK paths (ExactIn reports
  // the full `amountIn`); older shapes that omit it fall back to the request,
  // i.e. full-fill semantics. The refund is floored at zero so an
  // inconsistent quote can never report a negative remainder.
  // TF-APP-1: on a sell the SDK consumed the fee-EXCLUDED input — add the
  // withheld fee back so `consumedInput`/`amountLeft` stay in the gross units
  // the caller requested.
  const consumedCurveInput = BigInt(
    (quoteAny.includedFeeInputAmount ?? curveAmountIn.toString()).toString(),
  )
  const consumedInput = consumedCurveInput + inputTransferFee
  const amountLeftNet = BigInt((quoteAny.amountLeft ?? '0').toString())
  const amountLeft = amountIn >= consumedInput ? amountIn - consumedInput : 0n
  const curveAmountOut = BigInt(
    (quoteAny.outputAmount ?? quoteAny.amountOut ?? '0').toString(),
  )
  // TF-APP-1: on a buy the vault→trader transfer withholds the fee in the
  // TRADER's account — the wallet receives `outputAmount − fee`, and
  // `minimum_amount_out` is checked on that fee-excluded amount, so the floor
  // must be derived from the net, not the SDK's gross-derived
  // `minimumAmountOut` (which would revert once the fee exceeds slippage).
  const outputTransferFee =
    !swapBaseForQuote && feeBasis ? calculateTransferFeeAtomics(curveAmountOut, feeBasis) : 0n
  const amountOut = curveAmountOut - outputTransferFee
  const minimumAmountOut =
    outputTransferFee > 0n
      ? minimumAmountOutWithSlippage(amountOut, slippageBps)
      : BigInt(quoteAny.minimumAmountOut.toString())
  return {
    amountOut,
    minimumAmountOut,
    baseTransferFeeAtomics: inputTransferFee + outputTransferFee,
    consumedInput,
    amountLeft,
    amountLeftNet,
  }
}

export type DbcPoolRead = {
  readonly poolInfo: DbcPoolInfo
  /**
   * Quote against THIS read's pool/config state — `currentPoint` (slot /
   * block time) and the transfer-fee epoch are still read fresh inside the
   * quote; only the pool+config re-read is eliminated.
   */
  readonly quote: (params: {
    swapBaseForQuote: boolean
    amountIn: bigint
    slippageBps?: number
  }) => Promise<DbcSwapQuoteResult>
}

/**
 * Pool read + reusable quote in one pass — one `getPoolAndConfig` covers
 * pool info and any number of quotes, so the endpoints pay one pool+config
 * read instead of the two separate calls. Nothing is cached across calls.
 */
export async function fetchDbcPoolRead(
  poolAddress: string,
  deps: TradeClientDeps = {},
): Promise<DbcPoolRead> {
  const connection = deps.connection ?? getConnection()
  const client = deps.client ?? getDbcClient()
  const state = await getPoolAndConfig(client, poolAddress)
  const poolInfo = await poolInfoFromState(connection, state, deps.quoteAssets)
  return {
    poolInfo,
    // TF-APP-1: the mint read `poolInfoFromState` already did is reused —
    // passing its fee config stops `quoteFromState` re-reading the base mint.
    quote: ({ swapBaseForQuote, amountIn, slippageBps = DEFAULT_SLIPPAGE_BPS }) =>
      quoteFromState(
        client,
        connection,
        state,
        swapBaseForQuote,
        amountIn,
        slippageBps,
        poolInfo.baseTransferFee,
      ),
  }
}

/**
 * ISSUE-002: static worst-case CU limit for a DBC buy/sell — sized for the
 * heaviest instruction set the SDK builds (two ATA creations when neither
 * side's token account exists, plus wSOL wrap/sync/close on a SOL leg), not
 * the measured ~42–45k happy path. Simulation overrides it whenever the RPC
 * can simulate; this is only the fallback.
 */
export const DBC_SWAP_FALLBACK_COMPUTE_UNITS = 120_000

export type BuildDbcSwapParams = {
  poolAddress: string
  ownerAddress: string
  swapBaseForQuote: boolean
  amountIn: bigint
  minimumAmountOut: bigint
}

/**
 * Build the unsigned-by-owner swap transaction. Call order mirrors the
 * launch path: build ix → `feePayer` → `recentBlockhash` →
 * `applyEstimatedComputeBudget` (simulation needs the payer/blockhash
 * context) → serialize.
 */
export async function buildDbcSwapTx(
  params: BuildDbcSwapParams,
  deps: TradeClientDeps = {},
): Promise<{ transaction: string; lastValidBlockHeight: number }> {
  const { poolAddress, ownerAddress, swapBaseForQuote, amountIn, minimumAmountOut } = params
  const connection = deps.connection ?? getConnection()
  const client = deps.client ?? getDbcClient()
  const owner = new PublicKey(ownerAddress)
  // QA-34: buys route through `pool.swap2` with `SwapMode.PartialFill` so a
  // threshold-crossing buy consumes only enough quote to graduate the curve
  // and refunds the remainder, instead of failing with
  // `Insufficient Liquidity`. Sells stay on the full-fill `pool.swap` (base →
  // quote moves the reserve away from the threshold, so full-fill is always
  // satisfiable).
  const tx: Transaction = swapBaseForQuote
    ? await client.pool.swap({
        owner,
        pool: new PublicKey(poolAddress),
        swapBaseForQuote,
        referralTokenAccount: null,
        amountIn: toBN(amountIn),
        minimumAmountOut: toBN(minimumAmountOut),
      })
    : await client.pool.swap2({
        owner,
        pool: new PublicKey(poolAddress),
        swapBaseForQuote,
        swapMode: SwapMode.PartialFill,
        referralTokenAccount: null,
        amountIn: toBN(amountIn),
        minimumAmountOut: toBN(minimumAmountOut),
      })

  tx.feePayer = owner
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash

  // Estimate AFTER feePayer + recentBlockhash are set so the simulation sees
  // the final transaction context; budget ixs are prepended before serialize.
  await applyEstimatedComputeBudget(connection, tx, DBC_SWAP_FALLBACK_COMPUTE_UNITS)

  const serialized = tx.serialize({ requireAllSignatures: false })
  return {
    transaction: serialized.toString('base64'),
    // From the same getLatestBlockhash read as the blockhash — the agent's
    // proof that an unlanded send can no longer land before it rebuilds.
    lastValidBlockHeight,
  }
}
