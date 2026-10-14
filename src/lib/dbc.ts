/**
 * DBC (Dynamic Bonding Curve) helpers for the agent API.
 * Ported from launchpad-mobile-migration/src/services/dbcSwapClient.ts.
 */
import { BN } from '@coral-xyz/anchor'
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js'
import {
  DynamicBondingCurveClient,
  getCurrentPoint,
  type VirtualPool,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DBC_CONFIG_KEY, KNOWN_MINTS, NATIVE_MINT, RPC_URL } from './config'

function toBN(value: bigint): BN {
  return new BN(value.toString())
}

function getConnection(): Connection {
  return new Connection(RPC_URL, 'confirmed')
}

async function getPoolAndConfig(
  client: DynamicBondingCurveClient,
  poolAddress: string,
): Promise<{ virtualPool: VirtualPool; config: PoolConfig }> {
  const virtualPool = await client.state.getPool(new PublicKey(poolAddress))
  if (!virtualPool) throw new Error(`DBC pool not found: ${poolAddress}`)
  const config = await client.state.getPoolConfig(virtualPool.config)
  if (!config) throw new Error(`DBC pool config not found for pool: ${poolAddress}`)
  return { virtualPool, config }
}

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
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const { virtualPool, config } = await getPoolAndConfig(client, poolAddress)
  const quoteMint = config.quoteMint.toString()
  const known = KNOWN_MINTS[quoteMint]
  const quoteDecimals = known?.decimals ?? (await fetchMintDecimals(connection, config.quoteMint))
  return {
    poolAddress,
    baseMint: virtualPool.baseMint.toString(),
    quoteMint,
    quoteDecimals,
    quoteSymbol: known?.symbol ?? quoteMint.slice(0, 6) + '...',
    isQuoteSol: quoteMint === NATIVE_MINT,
    quoteReserve: virtualPool.quoteReserve.toString(),
    migrationQuoteThreshold: config.migrationQuoteThreshold.toString(),
    isCompleted: virtualPool.quoteReserve.gte(config.migrationQuoteThreshold),
  }
}

async function fetchMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(mint, 'confirmed')
  const decimals = info?.data?.[44]
  if (typeof decimals === 'number') return decimals
  throw new Error(`Cannot resolve decimals for mint ${mint.toString()}`)
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
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
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
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
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

export type LaunchTxResult = {
  transaction: string
  mintAddress: string
  metadataUrl: string
  imageUrl: string
}

export async function buildLaunchTx(params: {
  name: string
  symbol: string
  metadataUrl: string
  imageUrl: string
  payerAddress: string
  buyAmountLamports?: bigint
}): Promise<LaunchTxResult> {
  const { name, symbol, metadataUrl, imageUrl, payerAddress, buyAmountLamports } = params
  const connection = getConnection()
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const payer = new PublicKey(payerAddress)
  const config = new PublicKey(DBC_CONFIG_KEY)
  const mintKeypair = Keypair.generate()

  const createPoolParam = {
    config,
    baseMint: mintKeypair.publicKey,
    name,
    symbol: symbol.toUpperCase(),
    uri: metadataUrl,
    payer,
    poolCreator: payer,
  }

  let tx: Transaction
  if (buyAmountLamports && buyAmountLamports > 0n) {
    tx = await client.pool.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: {
        buyer: payer,
        buyAmount: toBN(buyAmountLamports),
        minimumAmountOut: new BN(1),
        referralTokenAccount: null,
      },
    })
  } else {
    tx = await client.pool.createPool(createPoolParam)
  }

  tx.feePayer = payer
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash

  // Partially sign with mint keypair — payer must add their signature before submitting
  tx.partialSign(mintKeypair)

  const serialized = tx.serialize({ requireAllSignatures: false })
  return {
    transaction: serialized.toString('base64'),
    mintAddress: mintKeypair.publicKey.toBase58(),
    metadataUrl,
    imageUrl,
  }
}
