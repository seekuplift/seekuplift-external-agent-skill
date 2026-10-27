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
 *
 * `source` (optional, default "curve") selects WHICH fees one call claims;
 * every call builds exactly one transaction:
 *   - "curve"    — the steps above, unchanged.
 *   - "position" — post-graduation fees in the migrated DAMM v2 pool, for
 *     the DAMM v2 position NFTs the creator wallet holds (a coin whose launch
 *     setup gives the creator a locked-liquidity share). Ported from the
 *     app's creator-position claim; no code is shared across repos:
 *       a. the pool must be migrated, its config must migrate to DAMM v2;
 *       b. the exact DAMM v2 pool is `deriveDammV2PoolAddress(dammConfig,
 *          base, quote)` where `dammConfig` is the DAMM v2 config the DBC
 *          config's `migrationFeeOption` maps to
 *          (`DAMM_V2_MIGRATION_FEE_ADDRESS`); an unmapped option is an
 *          explicit error, never a guess; the fetched pool's token mints
 *          must be exactly {base, quote};
 *       c. the wallet's positions in that pool come from cp-amm
 *          (`getUserPositionByPool`), pending fees from `getUnClaimLpFee`
 *          (older SDKs called it `getUnClaimReward`);
 *       d. cp-amm `claimPositionFee` builds the claim, resolving each
 *          mint's token program from the pool's flags (Token-2022 /
 *          transfer-fee mints) and creating any missing ATAs.
 *     A creator holding several claimable positions gets them all in the
 *     one transaction.
 */
import { PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { CP_AMM_PROGRAM_ID, CpAmm, getTokenProgram, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  MigrationOption,
  deriveDammV2PoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { getMobileConfigContext, type CatalogDeps } from './config-catalog.ts'
import {
  applyEstimatedComputeBudget,
  getConnection,
  getDbcClient,
  toBN,
  toBigIntish,
  unwrapConfig,
  unwrapPoolState,
} from './dbc-shared.ts'
import { getListedConfigKeys } from './config.ts'
import { deriveDbcPoolMigrationState } from './dbc-migration.ts'
import type { TradeClientDeps } from './dbc-trade.ts'
import { LaunchError } from './launch.ts'

/**
 * Static worst-case CU limit for a single-pool claim — the app's
 * `DBC_CLAIM_FALLBACK_COMPUTE_UNITS` (measured 22,030 CU happy path, plus
 * quote-ATA creation and wSOL unwrap). Simulation overrides it.
 */
export const DBC_CLAIM_FALLBACK_COMPUTE_UNITS = 60_000

/** Per-position worst case for a position claim (measured 54,183 CU with two
 *  ATA creations on a Token-2022 pair). Simulation overrides it. */
export const DAMM_POSITION_CLAIM_FALLBACK_COMPUTE_UNITS = 100_000

/** Which fees one `/api/claim/tx` call claims. */
export type ClaimSource = 'curve' | 'position'

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
  /** Present only for `source: "position"`. */
  source?: 'position'
  /** Present only for `source: "position"`: the exact migrated DAMM v2 pool. */
  dammPool?: string
  /** Present only for `source: "position"`: the claimed position accounts. */
  positions?: string[]
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

function parseSource(body: Record<string, unknown>): ClaimSource {
  const raw = body.source
  if (raw === undefined || raw === null) return 'curve'
  if (raw === 'curve' || raw === 'position') return raw
  throw new ClaimError('source must be "curve" or "position"')
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
  const source = parseSource(body)

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
    isMigrated?: unknown
    migrationProgress?: unknown
    creatorQuoteFee?: unknown
    creatorBaseFee?: unknown
  }

  const configKey = pool.config?.toString() ?? ''
  const ctx = await getMobileConfigContext(clientIp, deps.catalogDeps)
  const served =
    Object.values(ctx.options).some((refs) => (refs ?? []).some((ref) => ref.configKey === configKey)) ||
    getListedConfigKeys().includes(configKey)
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

  if (source === 'position') {
    return preparePositionClaimTx({ poolAddress, configKey, creator, pool, connection, client })
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

type DbcClient = NonNullable<ClaimDeps['client']>

/** `instruction` identity for de-duplicating the per-position pre/post steps. */
const ixKey = (ix: TransactionInstruction): string =>
  [
    ix.programId.toBase58(),
    ...ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 1 : 0}${k.isWritable ? 1 : 0}`),
    Buffer.from(ix.data).toString('base64'),
  ].join('|')

/**
 * `source: "position"` — see the module docstring. The caller has already
 * run the pool / served-config / creator guards.
 */
async function preparePositionClaimTx(args: {
  poolAddress: string
  configKey: string
  creator: string
  pool: {
    baseMint?: { toString(): string }
    isMigrated?: unknown
    migrationProgress?: unknown
  }
  connection: NonNullable<ClaimDeps['connection']>
  client: DbcClient
}): Promise<ClaimTxResult> {
  const { poolAddress, configKey, creator, pool, connection, client } = args

  const migrated =
    deriveDbcPoolMigrationState({
      isMigrated: pool.isMigrated,
      migrationProgress: pool.migrationProgress,
      quoteReserve: 0n,
      migrationQuoteThreshold: 1n,
    }) === 'migrated'
  if (!migrated) {
    throw new ClaimError('Pool has not migrated to DAMM v2 yet — no position fees exist', 409, {
      error: 'pool_not_migrated',
    })
  }

  const rawConfig = await client.state.getPoolConfig(new PublicKey(configKey))
  if (!rawConfig) {
    throw new ClaimError(`DBC pool config not found: ${configKey}`, 404, { error: 'config_not_found' })
  }
  const config = unwrapConfig(rawConfig) as {
    migrationOption?: unknown
    migrationFeeOption?: unknown
    quoteMint?: { toString(): string }
    creatorLiquidityPercentage?: unknown
    creatorPermanentLockedLiquidityPercentage?: unknown
  }
  if (Number(config.migrationOption) !== MigrationOption.MET_DAMM_V2) {
    throw new ClaimError('Pool config does not migrate to DAMM v2', 422, {
      error: 'not_damm_v2_migration',
    })
  }
  const feeOption = Number(config.migrationFeeOption)
  const dammConfig = Number.isInteger(feeOption) ? DAMM_V2_MIGRATION_FEE_ADDRESS[feeOption] : undefined
  if (!dammConfig) {
    throw new ClaimError(
      `Cannot resolve the migrated DAMM v2 pool: migrationFeeOption ${String(config.migrationFeeOption)} has no known DAMM v2 config`,
      422,
      { error: 'unmapped_migration_fee_option', migrationFeeOption: String(config.migrationFeeOption) },
    )
  }
  const baseMint = new PublicKey(pool.baseMint?.toString() ?? '')
  const quoteMint = new PublicKey(config.quoteMint?.toString() ?? '')
  const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint)

  const cpAmm = new CpAmm(connection)
  const poolState = await cpAmm.fetchPoolState(dammPool).catch((err) => {
    if (/not found/i.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  })
  if (!poolState) {
    throw new ClaimError(`Migrated DAMM v2 pool not found: ${dammPool.toBase58()}`, 404, {
      error: 'damm_pool_not_found',
      dammPool: dammPool.toBase58(),
    })
  }
  // Exactly the {base, quote} pair, in either order (cp-amm sorts its mints).
  const baseIsA = poolState.tokenAMint.equals(baseMint)
  const pairOk = baseIsA
    ? poolState.tokenBMint.equals(quoteMint)
    : poolState.tokenBMint.equals(baseMint) && poolState.tokenAMint.equals(quoteMint)
  if (!pairOk) {
    throw new ClaimError('Resolved DAMM v2 pool does not hold this coin\'s base/quote pair', 409, {
      error: 'damm_pool_mismatch',
      dammPool: dammPool.toBase58(),
    })
  }

  const owner = new PublicKey(creator)
  const held = await cpAmm.getUserPositionByPool(dammPool, owner)
  const claimable = held
    .map((p) => ({ ...p, fee: getUnClaimLpFee(poolState, p.positionState) }))
    .filter((p) => p.fee.feeTokenA.gtn(0) || p.fee.feeTokenB.gtn(0))
  if (claimable.length === 0) {
    const creatorShare =
      Number(config.creatorLiquidityPercentage ?? 0) +
      Number(config.creatorPermanentLockedLiquidityPercentage ?? 0)
    const reason =
      held.length > 0 ? 'no_fees_accrued' : creatorShare === 0 ? 'no_creator_share' : 'no_position_held'
    throw new ClaimError('No claimable position fees for this pool', 409, {
      error: 'no_claimable_fees',
      reason,
      dammPool: dammPool.toBase58(),
    })
  }

  // One claim per position; the ATA-creation / wSOL-close steps repeat, so
  // they are de-duplicated and the claims sit between them.
  const pre = new Map<string, TransactionInstruction>()
  const claims: TransactionInstruction[] = []
  const post = new Map<string, TransactionInstruction>()
  for (const p of claimable) {
    const built: Transaction = await cpAmm.claimPositionFee({
      owner,
      pool: dammPool,
      position: p.position,
      positionNftAccount: p.positionNftAccount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: getTokenProgram(poolState.tokenBFlag),
      feePayer: owner,
    })
    let seenClaim = false
    for (const ix of built.instructions) {
      if (ix.programId.equals(CP_AMM_PROGRAM_ID)) {
        claims.push(ix)
        seenClaim = true
      } else {
        const bucket = seenClaim ? post : pre
        bucket.set(ixKey(ix), ix)
      }
    }
  }
  const tx = new Transaction().add(...pre.values(), ...claims, ...post.values())
  tx.feePayer = owner
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  await applyEstimatedComputeBudget(
    connection,
    tx,
    Math.min(1_400_000, DAMM_POSITION_CLAIM_FALLBACK_COMPUTE_UNITS * claimable.length),
  )

  // DAMM token A/B -> the coin's base/quote. Token-2022 transfer-fee mints
  // deliver these amounts net of the mint's fee.
  let feeA = 0n
  let feeB = 0n
  for (const p of claimable) {
    feeA += toBigIntish(p.fee.feeTokenA) ?? 0n
    feeB += toBigIntish(p.fee.feeTokenB) ?? 0n
  }
  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    claimable: {
      quoteAtoms: (baseIsA ? feeB : feeA).toString(),
      baseAtoms: (baseIsA ? feeA : feeB).toString(),
    },
    poolInfo: { poolAddress, configKey, baseMint: baseMint.toBase58(), creator },
    source: 'position',
    dammPool: dammPool.toBase58(),
    positions: claimable.map((p) => p.position.toBase58()),
    lastValidBlockHeight,
  }
}
