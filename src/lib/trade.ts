/**
 * `/api/trade/*` orchestration — the agent-facing quote and transaction
 * builders, mirroring the app's routing decisions:
 *
 *   1. read the pool + its config on-chain (one pass);
 *   2. refuse non-`curve` pools — `migration_pending` is a retry-later state
 *      (the curve is finished but no graduated pool exists yet — do NOT
 *      route elsewhere), `migrated` points to Jupiter. Driven by the app's
 *      `migrationState` read, never the old reserve-threshold `isCompleted`;
 *   3. resolve the coin's geo category — the backend pool record's
 *      `launchType` first, then the pool's config → served-options mapping
 *      (the app's `derivePoolCategory`/`servedCategoryForConfigKey`), default
 *      `meme` — and the stock leg from the pool's ACTUAL quote mint;
 *   4. gate on the caller's fresh geo verdict: `<category>.trade` for
 *      idea/startup coins, `stock.trade` for stock-quoted coins; memecoin
 *      trading is never gated (fail open, D4);
 *   5. quote (50 bps default) or build the unsigned swap transaction.
 */
import { PublicKey } from '@solana/web3.js'
import { U64_MAX } from './first-buy.ts'
import { backendGetJson } from './backend.ts'
import {
  getMobileConfigContext,
  isStockQuoteMint,
  servedCategoryForConfigKey,
  type CatalogDeps,
} from './config-catalog.ts'
import { resolveTradeGeo, type LaunchCategory } from './geo.ts'
import { GeoRestrictedError, LaunchError } from './launch.ts'
import {
  buildDbcSwapTx,
  fetchDbcPoolRead,
  type DbcPoolRead,
  type TradeClientDeps,
} from './dbc-trade.ts'
import type { DbcPoolMigrationState } from './dbc-migration.ts'

/** A trade-path refusal with an HTTP status and structured error fields. */
export class TradeError extends LaunchError {
  constructor(message: string, status = 400, fields: Record<string, unknown> = {}) {
    super(message, status, fields)
    this.name = 'TradeError'
  }
}

/**
 * The pool's state is not tradeable on the curve — the typed refusal both
 * endpoints surface as a 409 carrying the routing state.
 */
export class PoolNotTradeableError extends TradeError {
  readonly migrationState: DbcPoolMigrationState
  constructor(migrationState: Exclude<DbcPoolMigrationState, 'curve'>) {
    super(
      migrationState === 'migrated'
        ? 'Pool has migrated — trade this token on Jupiter instead of the bonding curve'
        : 'Pool is waiting to migrate — retry later; do not route elsewhere',
      409,
      {
        error: 'pool_not_tradeable',
        migrationState,
        // `migration_pending` resolves itself once the migration crank lands;
        // `migrated` is terminal.
        retryable: migrationState === 'migration_pending',
      },
    )
    this.name = 'PoolNotTradeableError'
    this.migrationState = migrationState
  }
}

/** The backend pool record's `baseAsset` subset the category resolution reads. */
export type PoolMetadata = {
  launchType: string | null
}

/**
 * Injectable seams — tests substitute captured-fixture fetches and stub
 * clients; production defaults call the real backend + SDK.
 */
export type TradeDeps = TradeClientDeps & {
  /** `GET /api/stream/pools?assets=<baseMint>` — the backend pool record the
   *  app reads `launchType` from. Any failure resolves `null` (fail open). */
  fetchPoolMetadata?: (
    baseMint: string,
    clientIp: string | null,
  ) => Promise<PoolMetadata | null>
  /** Extra deps forwarded to `getMobileConfigContext` (its fetch, clock). */
  catalogDeps?: CatalogDeps
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseAtoms(value: unknown, field: string): bigint {
  const raw = typeof value === 'bigint' ? value.toString() : asTrimmedString(value)
  if (!raw || !/^\d+$/.test(raw)) {
    throw new TradeError(`${field} must be a non-negative integer atom count`)
  }
  const atoms = BigInt(raw)
  if (atoms > U64_MAX) throw new TradeError(`${field} exceeds the maximum u64 atom amount (18446744073709551615)`)
  return atoms
}

function normalizeCategory(value: string | null | undefined): LaunchCategory | null {
  return value === 'meme' || value === 'idea' || value === 'startup' ? value : null
}

async function defaultFetchPoolMetadata(
  baseMint: string,
  clientIp: string | null,
): Promise<PoolMetadata | null> {
  const raw = await backendGetJson<unknown>('/api/stream/pools', { assets: baseMint }, { clientIp })
  if (!Array.isArray(raw)) return null
  const pools = raw as { baseAsset?: { id?: unknown; launchType?: unknown } }[]
  const match = pools.find((pool) => pool?.baseAsset?.id === baseMint) ?? pools[0]
  const launchType = match?.baseAsset?.launchType
  return { launchType: typeof launchType === 'string' ? launchType : null }
}

type TradeBody = {
  poolAddress: string
  side: 'buy' | 'sell'
  amountIn: bigint
  slippageBps: number
}

function parseTradeBody(rawBody: unknown): TradeBody {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new TradeError('Request body must be a JSON object')
  }
  const body = rawBody as Record<string, unknown>
  const poolAddress = asTrimmedString(body.poolAddress)
  if (!poolAddress) throw new TradeError('Missing required field: poolAddress')
  try {
    new PublicKey(poolAddress)
  } catch {
    throw new TradeError('poolAddress is not a valid Solana address')
  }
  const sideRaw = asTrimmedString(body.side)
  if (sideRaw !== 'buy' && sideRaw !== 'sell') {
    throw new TradeError('side must be "buy" or "sell"')
  }
  if (body.amountIn == null) throw new TradeError('Missing required field: amountIn')
  const amountIn = parseAtoms(body.amountIn, 'amountIn')
  if (amountIn <= 0n) throw new TradeError('amountIn must be positive')
  let slippageBps = 50
  if (body.slippageBps != null) {
    const parsed = Number(body.slippageBps)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
      throw new TradeError('slippageBps must be a number between 0 and 10000')
    }
    slippageBps = parsed
  }
  return { poolAddress, side: sideRaw, amountIn, slippageBps }
}

type TradeContext = {
  read: DbcPoolRead
  category: LaunchCategory
  isStock: boolean
}

/**
 * The shared preflight: pool read → migration-state gate → geo gate, as the
 * app resolves them in the trade sheet. `migration_pending` and `migrated`
 * refuse BEFORE any quote/build; geo refuses with the backend's
 * `geo_restricted` body shape.
 */
async function loadTradeContext(
  poolAddress: string,
  clientIp: string | null,
  deps: TradeDeps,
): Promise<TradeContext> {
  // Fresh geo verdict + parsed options per request — `geo` is per caller and
  // never cached; the options/quote-asset parse rides the ~60s version cache.
  const ctx = await getMobileConfigContext(clientIp, deps.catalogDeps)
  let read: DbcPoolRead
  try {
    read = await fetchDbcPoolRead(poolAddress, { ...deps, quoteAssets: ctx.quoteAssets })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/DBC pool not found/.test(message)) {
      throw new TradeError(message, 404, { error: 'pool_not_found' })
    }
    if (/QUOTE_MINT_TRANSFER_FEE_UNSUPPORTED/.test(message)) {
      throw new TradeError(message, 409, {
        error: 'pool_not_tradeable',
        reason: 'quote_mint_transfer_fee_unsupported',
      })
    }
    throw err
  }
  const poolInfo = read.poolInfo

  // CA-A-5: routing is driven by the pool's own migration state — a full but
  // unmigrated curve must NEVER point to Jupiter (no DAMM pool exists yet).
  if (poolInfo.migrationState !== 'curve') {
    throw new PoolNotTradeableError(poolInfo.migrationState)
  }

  // Category resolution mirrors the app's `derivePoolCategory`: the backend
  // pool record's `launchType` wins; the pool's config → served-options
  // mapping is the fallback; an unclassifiable coin is `meme` (open).
  const fetchPoolMetadata = deps.fetchPoolMetadata ?? defaultFetchPoolMetadata
  let category: LaunchCategory | null = null
  try {
    category = normalizeCategory((await fetchPoolMetadata(poolInfo.baseMint, clientIp))?.launchType)
  } catch {
    category = null // fail open — D4
  }
  category ??= servedCategoryForConfigKey(ctx.options, poolInfo.configKey) ?? 'meme'

  const isStock = isStockQuoteMint(poolInfo.quoteMint, ctx.quoteAssets)
  const verdict = resolveTradeGeo(ctx.geo, category, isStock)
  if (!verdict.allowed) {
    throw new GeoRestrictedError(verdict.region, verdict.reason ?? 'unknown')
  }
  return { read, category, isStock }
}

const poolInfoForApi = (read: DbcPoolRead) => ({
  poolAddress: read.poolInfo.poolAddress,
  configKey: read.poolInfo.configKey,
  baseMint: read.poolInfo.baseMint,
  baseDecimals: read.poolInfo.baseDecimals,
  quoteMint: read.poolInfo.quoteMint,
  quoteDecimals: read.poolInfo.quoteDecimals,
  quoteSymbol: read.poolInfo.quoteSymbol,
  quoteScaledUiAmount: read.poolInfo.quoteScaledUiAmount,
  isQuoteSol: read.poolInfo.isQuoteSol,
  baseTransferFee: read.poolInfo.baseTransferFee != null,
  migrationState: read.poolInfo.migrationState,
  isCompleted: read.poolInfo.isCompleted,
})

export type TradeQuoteResult = {
  amountOut: string
  minimumAmountOut: string
  /** Base-mint transfer fee the quote implies, in base atoms ("0" fee-free). */
  baseTransferFeeAtomics: string
  /** Gross quote input the curve consumed, in atoms (buys may partial-fill). */
  consumedInput: string
  /** Estimated gross refund of unconsumed input for a partial-fill buy. */
  amountLeft: string
  amountIn: string
  slippageBps: number
  poolInfo: ReturnType<typeof poolInfoForApi>
}

/** `POST /api/trade/quote` — the curve quote behind `minimumAmountOut`. */
export async function prepareTradeQuote(
  rawBody: unknown,
  clientIp: string | null,
  deps: TradeDeps = {},
): Promise<TradeQuoteResult> {
  const { poolAddress, side, amountIn, slippageBps } = parseTradeBody(rawBody)
  const { read } = await loadTradeContext(poolAddress, clientIp, deps)
  // buy = quote→base (swapBaseForQuote: false), sell = base→quote (true)
  const quote = await read.quote({
    swapBaseForQuote: side === 'sell',
    amountIn,
    slippageBps,
  })
  return {
    amountOut: quote.amountOut.toString(),
    minimumAmountOut: quote.minimumAmountOut.toString(),
    baseTransferFeeAtomics: quote.baseTransferFeeAtomics.toString(),
    consumedInput: quote.consumedInput.toString(),
    amountLeft: quote.amountLeft.toString(),
    amountIn: amountIn.toString(),
    slippageBps,
    poolInfo: poolInfoForApi(read),
  }
}

export type TradeTxResult = {
  transaction: string
  amountIn: string
  minimumAmountOut: string
  /** The fresh quote the floor was computed from — always present. */
  quote: Omit<TradeQuoteResult, 'poolInfo'>
  poolInfo: ReturnType<typeof poolInfoForApi>
  /** Expiry bound from the tx's getLatestBlockhash read — see SKILL.md's
   *  submit protocol (prove an unlanded send before rebuilding). */
  lastValidBlockHeight: number
}

/** `POST /api/trade/tx` — the unsigned-by-owner swap transaction. */
export async function prepareTradeTx(
  rawBody: unknown,
  clientIp: string | null,
  deps: TradeDeps = {},
): Promise<TradeTxResult> {
  const { poolAddress, side, amountIn, slippageBps } = parseTradeBody(rawBody)
  const body = rawBody as Record<string, unknown>
  const ownerAddress = asTrimmedString(body.ownerPublicKey)
  if (!ownerAddress) throw new TradeError('Missing required field: ownerPublicKey')
  try {
    new PublicKey(ownerAddress)
  } catch {
    throw new TradeError('ownerPublicKey is not a valid Solana address')
  }
  const requestedMinOut =
    body.minimumAmountOut != null
      ? parseAtoms(body.minimumAmountOut, 'minimumAmountOut')
      : null

  const { read } = await loadTradeContext(poolAddress, clientIp, deps)
  const swapBaseForQuote = side === 'sell'
  // TB-S-3: the output floor is ALWAYS recomputed from a fresh quote at the
  // request's slippage — never taken verbatim from the caller. A supplied
  // `minimumAmountOut` may only TIGHTEN the floor (higher = the caller
  // demands more output); anything below the computed floor — including "0",
  // which used to disable slippage protection — is a 400 naming the floor.
  const result = await read.quote({ swapBaseForQuote, amountIn, slippageBps })
  const floor = result.minimumAmountOut
  let minimumAmountOut = floor
  if (requestedMinOut != null) {
    if (requestedMinOut < floor) {
      throw new TradeError(
        `minimumAmountOut ${requestedMinOut} is below the slippage floor ${floor} quoted at ${slippageBps} bps — pass a value >= the floor or omit the field`,
        400,
        {
          error: 'min_out_below_floor',
          minimumAmountOutFloor: floor.toString(),
          slippageBps,
        },
      )
    }
    minimumAmountOut = requestedMinOut
  }
  const quote: TradeTxResult['quote'] = {
    amountOut: result.amountOut.toString(),
    minimumAmountOut: result.minimumAmountOut.toString(),
    baseTransferFeeAtomics: result.baseTransferFeeAtomics.toString(),
    consumedInput: result.consumedInput.toString(),
    amountLeft: result.amountLeft.toString(),
    amountIn: amountIn.toString(),
    slippageBps,
  }

  const { transaction, lastValidBlockHeight } = await buildDbcSwapTx(
    {
      poolAddress: read.poolInfo.poolAddress,
      ownerAddress,
      swapBaseForQuote,
      amountIn,
      minimumAmountOut,
    },
    deps,
  )
  return {
    transaction,
    amountIn: amountIn.toString(),
    minimumAmountOut: minimumAmountOut.toString(),
    quote,
    poolInfo: poolInfoForApi(read),
    lastValidBlockHeight,
  }
}
