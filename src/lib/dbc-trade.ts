/**
 * DBC trade helpers: pool info, swap quotes, swap transaction building.
 * Moved out of the old single `dbc.ts` — ticket 05 (buy/sell) owns this
 * module. Shared plumbing lives in `./dbc-shared.ts`.
 */
import { PublicKey, Transaction } from '@solana/web3.js'
import { getCurrentPoint } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { KNOWN_MINTS, NATIVE_MINT } from './config.ts'
import {
  fetchMintDecimals,
  getConnection,
  getDbcClient,
  getPoolAndConfig,
  toBN,
} from './dbc-shared.ts'

export type DbcPoolInfo = {
  poolAddress: string
  baseMint: string
  quoteMint: string
  quoteDecimals: number
  quoteSymbol: string
  isQuoteSol: boolean
  quoteReserve: string
  migrationQuoteThreshold: string
  isCompleted: boolean
}

export async function fetchDbcPoolInfo(poolAddress: string): Promise<DbcPoolInfo> {
  const connection = getConnection()
  const client = getDbcClient()
  const { poolState, config } = await getPoolAndConfig(client, poolAddress)
  const quoteMint = config.quoteMint.toString()
  const known = KNOWN_MINTS[quoteMint]
  const quoteDecimals = known?.decimals ?? (await fetchMintDecimals(connection, config.quoteMint))
  return {
    poolAddress,
    baseMint: poolState.baseMint.toString(),
    quoteMint,
    quoteDecimals,
    quoteSymbol: known?.symbol ?? quoteMint.slice(0, 6) + '...',
    isQuoteSol: quoteMint === NATIVE_MINT,
    quoteReserve: poolState.quoteReserve.toString(),
    migrationQuoteThreshold: config.migrationQuoteThreshold.toString(),
    isCompleted: poolState.quoteReserve.gte(config.migrationQuoteThreshold),
  }
}

export type SwapQuoteResult = {
  amountOut: string
  minimumAmountOut: string
}

export async function fetchDbcSwapQuote(params: {
  poolAddress: string
  swapBaseForQuote: boolean
  amountIn: bigint
  slippageBps?: number
}): Promise<SwapQuoteResult> {
  const { poolAddress, swapBaseForQuote, amountIn, slippageBps = 50 } = params
  const connection = getConnection()
  const client = getDbcClient()
  const { virtualPool, config } = await getPoolAndConfig(client, poolAddress)
  const currentPoint = await getCurrentPoint(connection, config.activationType)

  const quote = client.pool.swapQuote({
    virtualPool,
    config,
    swapBaseForQuote,
    amountIn: toBN(amountIn),
    slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  })

  const quoteAny = quote as unknown as Record<string, { toString(): string }>
  return {
    amountOut: (quoteAny.outputAmount ?? quoteAny.amountOut ?? '0').toString(),
    minimumAmountOut: quote.minimumAmountOut.toString(),
  }
}

export async function buildDbcSwapTx(params: {
  poolAddress: string
  ownerAddress: string
  swapBaseForQuote: boolean
  amountIn: bigint
  minimumAmountOut: bigint
}): Promise<{ transaction: string }> {
  const { poolAddress, ownerAddress, swapBaseForQuote, amountIn, minimumAmountOut } = params
  const connection = getConnection()
  const client = getDbcClient()
  const owner = new PublicKey(ownerAddress)

  const tx: Transaction = await client.pool.swap({
    owner,
    pool: new PublicKey(poolAddress),
    swapBaseForQuote,
    referralTokenAccount: null,
    amountIn: toBN(amountIn),
    minimumAmountOut: toBN(minimumAmountOut),
  })

  tx.feePayer = owner
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash

  const serialized = tx.serialize({ requireAllSignatures: false })
  return { transaction: serialized.toString('base64') }
}
