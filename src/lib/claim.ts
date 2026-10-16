/**
 * `/api/claim/tx` — the unsigned creator-fee claim transaction for one pool.
 *
 * Ported from the app's `buildClaimCreatorFeeTx`
 * (launchpad-mobile-redesign/src/services/dbc-swap-client.ts):
 *
 *   1. read the pool on-chain (`pool_not_found` when there is none);
 *   2. refuse a pool whose config this deployment does not serve — the API
 *      only claims SeekUplift coins, never an arbitrary DBC pool;
 *   3. refuse unless `creatorPublicKey` is the pool's on-chain creator (the
 *      program would reject the claim anyway; refusing early saves a sign);
 *   4. refuse when both creator fee buckets are empty;
 *   5. build `claimCreatorTradingFee` for the full claimable amounts, with
 *      the creator as fee payer, and budget it like the other builders.
 *
 * No geo gate: the app's Rewards claim has none — fees already earned stay
 * claimable wherever the creator is. Works on the curve and after
 * migration (the creator buckets live on the virtual pool either way).
 */
import { PublicKey, type Transaction } from '@solana/web3.js'
import { getMobileConfigContext, type CatalogDeps } from './config-catalog.ts'
import {
  applyEstimatedComputeBudget,
  getConnection,
  getDbcClient,
  toBN,
  unwrapPoolState,
} from './dbc-shared.ts'
import type { TradeClientDeps } from './dbc-trade.ts'
import { LaunchError } from './launch.ts'

/**
 * Static worst-case CU limit for a single-pool claim — the app's
 * `DBC_CLAIM_FALLBACK_COMPUTE_UNITS` (measured 22,030 CU happy path, plus
 * quote-ATA creation and wSOL unwrap). Simulation overrides it.
 */
export const DBC_CLAIM_FALLBACK_COMPUTE_UNITS = 60_000

export class ClaimError extends LaunchError {
  constructor(message: string, status = 400, fields: Record<string, unknown> = {}) {
    super(message, status, fields)
    this.name = 'ClaimError'
  }
}

export type ClaimDeps = Pick<TradeClientDeps, 'connection' | 'client'> & {
  catalogDeps?: CatalogDeps
}

export type ClaimTxResult = {
  transaction: string
  claimable: {
    /** Creator quote-fee atoms the transaction claims. */
    quoteAtoms: string
    /** Creator base-fee atoms the transaction claims. */
    baseAtoms: string
  }
  poolInfo: {
    poolAddress: string
    configKey: string
    baseMint: string
    creator: string
  }
  /** Expiry bound from the same `getLatestBlockhash` read as the blockhash —
   *  the agent's proof that an unlanded send can no longer land (SKILL.md's
   *  submit protocol). */
  lastValidBlockHeight: number
}

function parseAddress(body: Record<string, unknown>, field: string): string {
  const raw = typeof body[field] === 'string' ? (body[field] as string).trim() : ''
  if (!raw) throw new ClaimError(`Missing required field: ${field}`)
  try {
    new PublicKey(raw)
  } catch {
    throw new ClaimError(`${field} is not a valid Solana address`)
  }
  return raw
}

const atoms = (value: unknown): bigint => {
  const text = value == null ? '0' : String(value)
  return /^\d+$/.test(text) ? BigInt(text) : 0n
}

/** `POST /api/claim/tx` — see the module docstring. */
export async function prepareClaimTx(
  rawBody: unknown,
  clientIp: string | null,
  deps: ClaimDeps = {},
): Promise<ClaimTxResult> {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new ClaimError('Request body must be a JSON object')
  }
  const body = rawBody as Record<string, unknown>
  const poolAddress = parseAddress(body, 'poolAddress')
  const creatorAddress = parseAddress(body, 'creatorPublicKey')

  const connection = deps.connection ?? getConnection()
  const client = deps.client ?? getDbcClient()

  const rawPool = await client.state.getPool(new PublicKey(poolAddress)).catch((err) => {
    if (/Invalid account discriminator/.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  })
  if (!rawPool) {
    throw new ClaimError(`DBC pool not found: ${poolAddress}`, 404, { error: 'pool_not_found' })
  }
  const pool = unwrapPoolState(rawPool) as unknown as {
    config?: { toString(): string }
    baseMint?: { toString(): string }
    creator?: { toString(): string }
    creatorQuoteFee?: unknown
    creatorBaseFee?: unknown
  }

  const configKey = pool.config?.toString() ?? ''
  const ctx = await getMobileConfigContext(clientIp, deps.catalogDeps)
  const served = Object.values(ctx.options).some((refs) =>
    (refs ?? []).some((ref) => ref.configKey === configKey),
  )
  if (!served) {
    throw new ClaimError(
      'Pool config is not served by SeekUplift — claim in the SeekUplift app instead',
      403,
      { error: 'config_not_served', configKey },
    )
  }

  const creator = pool.creator?.toString() ?? ''
  if (creator !== creatorAddress) {
    throw new ClaimError('creatorPublicKey is not this pool\'s creator', 403, {
      error: 'not_creator',
      creator,
    })
  }

  const claimableQuote = atoms(pool.creatorQuoteFee)
  const claimableBase = atoms(pool.creatorBaseFee)
  if (claimableQuote <= 0n && claimableBase <= 0n) {
    throw new ClaimError('No claimable creator fees for this pool', 409, {
      error: 'no_claimable_fees',
    })
  }

  const owner = new PublicKey(creatorAddress)
  const tx: Transaction = await client.creator.claimCreatorTradingFee({
    creator: owner,
    payer: owner,
    pool: new PublicKey(poolAddress),
    maxBaseAmount: toBN(claimableBase),
    maxQuoteAmount: toBN(claimableQuote),
  })
  tx.feePayer = owner
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  await applyEstimatedComputeBudget(connection, tx, DBC_CLAIM_FALLBACK_COMPUTE_UNITS)

  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    claimable: { quoteAtoms: claimableQuote.toString(), baseAtoms: claimableBase.toString() },
    poolInfo: {
      poolAddress,
      configKey,
      baseMint: pool.baseMint?.toString() ?? '',
      creator,
    },
    lastValidBlockHeight,
  }
}
