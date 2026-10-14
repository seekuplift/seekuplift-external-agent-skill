/**
 * DBC launch transaction building — the module tickets 02 (launch on a chosen
 * config) and 04 (stock-quoted launches) extend. Shared plumbing lives in
 * `./dbc-shared.ts`; the catalog in `./config-catalog.ts` resolves the config
 * key an agent picks.
 *
 * Ported from launchpad-mobile-redesign/src/services/dbc-launch-client.ts,
 * adapted to this service's existing request shape (SDK ≥1.5.13: builds go
 * through `client.creator`, not the retired `client.pool.createPool`).
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { DBC_CONFIG_KEY } from './config.ts'
import { getConnection, getDbcClient, toBN } from './dbc-shared.ts'

/**
 * Static worst-case CU limit for a DBC `createPool` (app constant
 * `DBC_CREATE_POOL_FALLBACK_COMPUTE_UNITS`, measured 68–80k on a mainnet
 * fork). Exported for ticket 02 — `buildLaunchTx` itself adds no compute-
 * budget instructions, matching the previous route behavior.
 */
export const DBC_CREATE_POOL_FALLBACK_COMPUTE_UNITS = 110_000

/** Static worst-case CU limit for `createPoolWithFirstBuy` (app constant). */
export const DBC_CREATE_POOL_WITH_FIRST_BUY_FALLBACK_COMPUTE_UNITS = 200_000

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
  /** Pool config key; defaults to the legacy env config. */
  configKey?: string
}): Promise<LaunchTxResult> {
  const { name, symbol, metadataUrl, imageUrl, payerAddress, buyAmountLamports } = params
  const configKey = params.configKey ?? DBC_CONFIG_KEY
  const connection = getConnection()
  const client = getDbcClient()
  const payer = new PublicKey(payerAddress)
  const config = new PublicKey(configKey)
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
    tx = await client.creator.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: {
        buyer: payer,
        buyAmount: toBN(buyAmountLamports),
        minimumAmountOut: toBN(1n),
        referralTokenAccount: null,
      },
    })
  } else {
    tx = await client.creator.createPool(createPoolParam)
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
