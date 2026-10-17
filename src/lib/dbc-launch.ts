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
  getCurrentPoint,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  applyEstimatedComputeBudget,
  getConnection,
  getDbcClient,
  quoteAmountOut,
  toBN,
  toFiniteNumber,
  unwrapConfig,
} from './dbc-shared.ts'
import { minimumAmountOutWithSlippage } from './transfer-fee.ts'

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

/**
 * Default slippage on the creator first-buy output floor, in bps — the same
 * 50 bps default the trade endpoints use. The launch request can override it
 * with `firstBuySlippageBps` (see src/lib/launch.ts; contract: SKILL.md).
 */
export const FIRST_BUY_DEFAULT_SLIPPAGE_BPS = 50

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
  /**
   * Slippage budget for the first-buy output floor, in bps — the built
   * transaction's `minimumAmountOut` is the simulated opening-curve quote
   * discounted by this (`floor(out × (10_000 − bps) / 10_000)`, ≥ 1 atom).
   * Default `FIRST_BUY_DEFAULT_SLIPPAGE_BPS` (50). Callers cap the range —
   * the launch route applies the same 0–1000 (5000 with allowHighSlippage)
   * ceiling as the trade endpoints.
   */
  firstBuySlippageBps?: number
}

export type LaunchTxResult = {
  /** Base64-serialized legacy `Transaction`, partially mint-signed. */
  transaction: string
  mintAddress: string
  poolAddress: string
  /** Expiry bound from the same `getLatestBlockhash` read that supplied the
   *  blockhash — the agent needs it to prove a sent tx can no longer land
   *  before rebuilding (a rebuild mints a NEW mint + pool). */
  lastValidBlockHeight: number
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

/**
 * The first-buy output floor: a simulated ExactIn quote against the pool's
 * opening state — `client.pool.getQuoteFromInputAmount` builds a virtual
 * pool at `sqrtStartPrice` with zeroed reserves, the same curve math the
 * on-chain first buy executes. The result's output, discounted by
 * `slippageBps` (`minimumAmountOutWithSlippage`), becomes the swap's
 * `minimumAmountOut`.
 *
 * Fail-loud by construction:
 *   - the on-chain first buy is an ExactIn FULL fill, so an amount the
 *     opening curve cannot fill throws here — at build time — instead of
 *     reverting when the transaction lands;
 *   - an unrecognized quote result shape throws `DbcQuoteShapeError` (a
 *     renamed SDK field must never read as a zero quote);
 *   - the derived floor is clamped ≥ 1 atom: a quoted-zero buy buys nothing,
 *     and reverting beats funding a pool whose first buy yields no tokens.
 */
async function quoteFirstBuyMinimumOut(
  client: ReturnType<typeof getDbcClient>,
  connection: ReturnType<typeof getConnection>,
  config: PublicKey,
  buyAmountAtoms: bigint,
  slippageBps: number,
): Promise<bigint> {
  const rawConfig = await client.state.getPoolConfig(config)
  if (rawConfig == null) {
    throw new Error(`DBC pool config not found for first-buy quote: ${config.toBase58()}`)
  }
  const poolConfig = unwrapConfig(rawConfig)
  const activationType = toFiniteNumber(poolConfig.activationType) ?? 0
  const currentPoint = await getCurrentPoint(connection, activationType)
  const quote = (
    client.pool as unknown as {
      getQuoteFromInputAmount(args: Record<string, unknown>): Record<string, unknown>
    }
  ).getQuoteFromInputAmount({
    config: poolConfig,
    swapBaseForQuote: false, // buy: quote atoms in, base tokens out
    amountIn: toBN(buyAmountAtoms),
    slippageBps,
    hasReferral: false,
    // The on-chain first swap pays the config's minimum base fee when the
    // flag is set — quote under the same fee or the floor is oversized. The
    // anchor decode yields `1`/`0` (verified against the recorded mainnet
    // config); the boolean arm covers bool-shaped decoders/stubs.
    eligibleForFirstSwapWithMinFee:
      poolConfig.enableFirstSwapWithMinFee === true ||
      toFiniteNumber(poolConfig.enableFirstSwapWithMinFee) === 1,
    currentPoint,
  })
  const floor = minimumAmountOutWithSlippage(quoteAmountOut(quote), slippageBps)
  return floor > 0n ? floor : 1n
}

export async function buildLaunchTx(
  params: BuildLaunchTxParams,
  deps: BuildLaunchTxDeps = {},
): Promise<LaunchTxResult> {
  const {
    name,
    symbol,
    metadataUrl,
    payerAddress,
    configKey,
    quoteMint,
    firstBuyAtoms,
    firstBuySlippageBps = FIRST_BUY_DEFAULT_SLIPPAGE_BPS,
  } = params
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
    // DD-S-2: the first buy used to ship `minimumAmountOut: 1` — no floor at
    // all. Now the floor comes from a simulated quote on the pool's opening
    // state, discounted by firstBuySlippageBps.
    const minimumAmountOut = await quoteFirstBuyMinimumOut(
      client,
      connection,
      config,
      firstBuyAtoms,
      firstBuySlippageBps,
    )
    tx = await client.creator.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: {
        buyer: payer,
        buyAmount: toBN(firstBuyAtoms),
        minimumAmountOut: toBN(minimumAmountOut),
        referralTokenAccount: null,
      },
    })
  } else {
    tx = await client.creator.createPool(createPoolParam)
  }

  tx.feePayer = payer
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed')
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
    lastValidBlockHeight,
  }
}
