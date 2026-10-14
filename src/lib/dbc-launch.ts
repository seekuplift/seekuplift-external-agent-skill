/**
 * DBC launch transaction building — ported from
 * launchpad-mobile-redesign/src/services/dbc-launch-client.ts (SDK ≥1.5.13:
 * builds go through `client.creator`, not the retired `client.pool.createPool`).
 *
 * Call order mirrors the app exactly:
 *   build ix → `feePayer` → `recentBlockhash` → `applyEstimatedComputeBudget`
 *   (simulation needs the payer/blockhash context) → mint `partialSign` →
 *   serialize. The returned transaction is unsigned-by-the-payer — the agent
 *   must sign with `payerAddress` before submitting.
 *
 * SQ-APP-3 parity: for a quote mint carrying an on-chain token badge
 * (badged Token-2022 stock quotes), the derived badge PDA is attached to
 * `createPoolParam` — DBC 0.2.1 requires it as remaining account 0 for
 * quote mints that aren't permissionless-supported.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  deriveDbcPoolAddress,
  deriveTokenBadgeAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  applyEstimatedComputeBudget,
  getConnection,
  getDbcClient,
  toBN,
} from './dbc-shared.ts'

/**
 * Static worst-case CU limit for a DBC `createPool` (app constant
 * `DBC_CREATE_POOL_FALLBACK_COMPUTE_UNITS`; remeasured 68,503 CU SKR-quoted /
 * 80,113 CU badged-quote on a mainnet fork). Simulation overrides it.
 */
export const DBC_CREATE_POOL_FALLBACK_COMPUTE_UNITS = 110_000

/**
 * Static worst-case CU limit for `createPoolWithFirstBuy` (app constant;
 * remeasured 144,259 CU SKR-quoted / 138,089 CU badged-quote on a fork).
 */
export const DBC_CREATE_POOL_WITH_FIRST_BUY_FALLBACK_COMPUTE_UNITS = 200_000

/** Test seam — the network-facing collaborators of `buildLaunchTx`. */
export type BuildLaunchTxDeps = {
  connection?: ReturnType<typeof getConnection>
  client?: ReturnType<typeof getDbcClient>
}

export type BuildLaunchTxParams = {
  /** Canonical identity (already trimmed/uppercased). */
  name: string
  symbol: string
  metadataUrl: string
  payerAddress: string
  /** The agent-chosen config key from `GET /api/configs` (required). */
  configKey: string
  /** The config's quote mint — used for the badge lookup + pool derivation. */
  quoteMint: string
  /** Raw quote atoms for the bundled creator first buy; omitted/0 → plain
   *  `createPool`. Never pass ≤ 0 to the SDK. */
  firstBuyAtoms?: bigint
}

export type LaunchTxResult = {
  /** Base64-serialized legacy `Transaction`, partially mint-signed. */
  transaction: string
  mintAddress: string
  poolAddress: string
}

/**
 * Resolve the DBC token-badge PDA for the quote mint, when a badge exists
 * on-chain (app `resolveTokenBadgeAddress`). A badge can only exist where an
 * operator created one, so for SKR/SOL/USDC this resolves undefined and the
 * instruction payload is unchanged.
 */
async function resolveTokenBadgeAddress(
  client: ReturnType<typeof getDbcClient>,
  quoteMint: PublicKey,
): Promise<PublicKey | undefined> {
  const badge = await client.state.getTokenBadge(quoteMint)
  return badge ? deriveTokenBadgeAddress(quoteMint) : undefined
}

export async function buildLaunchTx(
  params: BuildLaunchTxParams,
  deps: BuildLaunchTxDeps = {},
): Promise<LaunchTxResult> {
  const { name, symbol, metadataUrl, payerAddress, configKey, quoteMint, firstBuyAtoms } = params
  const connection = deps.connection ?? getConnection()
  const client = deps.client ?? getDbcClient()
  const payer = new PublicKey(payerAddress)
  const config = new PublicKey(configKey)
  const mintKeypair = Keypair.generate()

  // SQ-APP-3: attached only when the quote mint has a badge on-chain.
  const tokenBadge = await resolveTokenBadgeAddress(client, new PublicKey(quoteMint))
  const createPoolParam = {
    config,
    baseMint: mintKeypair.publicKey,
    name,
    symbol,
    uri: metadataUrl,
    payer,
    poolCreator: payer,
    ...(tokenBadge ? { tokenBadge } : {}),
  }

  let tx: Transaction
  if (firstBuyAtoms && firstBuyAtoms > 0n) {
    tx = await client.creator.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: {
        buyer: payer,
        buyAmount: toBN(firstBuyAtoms),
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

  // Estimate AFTER feePayer + recentBlockhash are set so the simulation sees
  // the final transaction context; budget ixs are prepended before signing.
  await applyEstimatedComputeBudget(
    connection,
    tx,
    firstBuyAtoms && firstBuyAtoms > 0n
      ? DBC_CREATE_POOL_WITH_FIRST_BUY_FALLBACK_COMPUTE_UNITS
      : DBC_CREATE_POOL_FALLBACK_COMPUTE_UNITS,
  )

  // Partially sign with the mint keypair — the payer signature is still
  // required before submission.
  tx.partialSign(mintKeypair)

  const serialized = tx.serialize({ requireAllSignatures: false })
  const poolAddress = deriveDbcPoolAddress(
    new PublicKey(quoteMint),
    mintKeypair.publicKey,
    config,
  ).toBase58()
  return {
    transaction: serialized.toString('base64'),
    mintAddress: mintKeypair.publicKey.toBase58(),
    poolAddress,
  }
}
