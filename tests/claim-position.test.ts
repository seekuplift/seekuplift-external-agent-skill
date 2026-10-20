/**
 * `/api/claim/tx` `source: "position"` tests — `prepareClaimTx` in
 * src/lib/claim.ts.
 *
 * The DAMM v2 side is real: the migrated cp-amm pool, the partner/creator
 * position accounts and the creator's `claim_position_fee` transaction come
 * from the dbc-config bootstrap-migration capture (tests/fixtures/
 * damm-position-claim/, see the fixtures README). The captured decoded
 * accounts are re-encoded to account bytes and served through the real
 * @meteora-ag/cp-amm-sdk decoder via patched Connection reads. The DBC pool
 * and config are stub-client values copied from that capture's run.json and
 * the prepared bootstrap batch plan (creator LP 30/0; cause-only 0/0).
 *
 * The positions fixture was captured AFTER the creator claim (checkpoint set,
 * claimed fee recorded) and the pool fixture BEFORE any DAMM trade. The
 * pre-claim claimable state is derived from the two: pool fee-per-liquidity
 * := the position's post-claim checkpoint (a claim sets the checkpoint to the
 * pool value), position checkpoint/claimed := 0. The test asserts the derived
 * claimable equals the captured claim tx's real SKR transfer.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import BN from 'bn.js'
import { utils } from '@coral-xyz/anchor'
import { AccountLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { CP_AMM_PROGRAM_ID, cpAmmCoder } from '@meteora-ag/cp-amm-sdk'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  type DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { ClaimError, prepareClaimTx, type ClaimDeps } from '../src/lib/claim.ts'
import { resetConfigCatalogCachesForTests } from '../src/lib/config-catalog.ts'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'damm-position-claim')
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'))

const flatPool = fixture('flat-10-1000-damm-pool.json')
const flatPositions = fixture('flat-10-1000-damm-positions.json')
const claimTx = fixture('flat-10-1000-creator-claim-tx.json')
const causePool = fixture('cause-flat-10-1000-damm-pool.json')
const causePositions = fixture('cause-flat-10-1000-damm-positions.json')

// run.json rows of the capture.
const SKR = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
const DAMM_CONFIG = 'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck'
const FLAT = {
  dbcPool: 'FXVSbk3ApA2kfhK8AJELWJAamWTiZxExroSKazErh61H',
  baseMint: '4gfUchdR2orb2vWTRCqXcXNBMpQm6mH2wqVP4Sxj5J48',
  creator: '7m6CHNnw7C7pg4YAAVVxMYpb7PSNVZZ4VJQm73QhqCQ1',
  config: '4n6oCfQj9wkdSWaue6vzimx7Le8F8V5wBve9YCicUvBs',
  dammPool: 'NT7QWHUmi8gYjtaDHtrnVm31Jwg2oB72twYunaYtmw8',
}
const CAUSE = {
  dbcPool: 'FzPmdtqBKKGZLk7Sjqqw3qyNfZsbcP6fPYvh4RPKPDiL',
  baseMint: 'DsMnw1a9YNgX4N6XFxCit8vwLAM4c72q3WdLiU9sibiu',
  creator: 'b8RuBroizaNsbTbKNmucZdzr71XjRJ8PZ8zZyjZTrYN',
  config: '5YSUgMZ2qrWgmqvuoErEh2skaQaJQtv5FVjpXZFg58G1',
  dammPool: 'D4tK28Yf5n8ANygAzU7VmnyQjxgAcnZULo3XRCow2uLc',
}

// ── Real captured accounts -> account bytes ──────────────────────────────────
const PUBKEY_FIELDS = new Set([
  'tokenAMint', 'tokenBMint', 'tokenAVault', 'tokenBVault', 'whitelistedVault',
  'creator', 'pool', 'nftMint', 'mint', 'vault', 'funder',
])
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
/** Decoded-JSON -> anchor-layout input (BN / PublicKey / Buffer, snake_case). */
function toLayout(o: unknown, key = ''): unknown {
  if (Array.isArray(o)) {
    return o.length && o.every((x) => typeof x === 'number') ? Buffer.from(o) : o.map((x) => toLayout(x))
  }
  if (o && typeof o === 'object') {
    const rec = o as Record<string, unknown>
    if ('_bn' in rec) {
      const bn = new BN(String(rec._bn))
      return PUBKEY_FIELDS.has(key) ? new PublicKey(bn.toArrayLike(Buffer, 'be', 32)) : bn
    }
    return Object.fromEntries(Object.entries(rec).map(([k, v]) => [snake(k), toLayout(v, k)]))
  }
  if (typeof o === 'string' && /^-?\d+$/.test(o)) return new BN(o)
  return o
}
function encodeAccount(name: 'Pool' | 'Position', decoded: unknown): Buffer {
  const coder = cpAmmCoder.accounts as unknown as {
    accountLayouts: Map<string, { layout: { encode(o: unknown, b: Buffer): number } }>
    accountDiscriminator(n: string): Buffer
  }
  const buf = Buffer.alloc(4096)
  const len = coder.accountLayouts.get(name)!.layout.encode(toLayout(decoded), buf)
  return Buffer.concat([coder.accountDiscriminator(name), buf.subarray(0, len)])
}
const leU256 = (bytes: number[]) => bytes.reduceRight((x, b) => x * 256n + BigInt(b), 0n)

/** Real SKR the captured creator claim moved to the creator. */
const CAPTURED_CLAIM_ATOMS = (() => {
  const inner = claimTx.meta.innerInstructions.flatMap((g: { instructions: unknown[] }) => g.instructions)
  const t = (inner as { parsed?: { type: string; info: { mint?: string; tokenAmount?: { amount: string } } } }[])
    .find((i) => i.parsed?.type === 'transferChecked' && i.parsed.info.mint === SKR)
  return t!.parsed!.info.tokenAmount!.amount
})()

type Scenario = {
  ids: typeof FLAT
  damm: typeof flatPool
  positions: typeof flatPositions
  /** pre-claim reconstruction (see header) vs the fixtures as captured */
  preClaim: boolean
  /** NFT owners whose token accounts the wallet lists */
  walletHoldsCreatorPosition: boolean
}

let scenario: Scenario
let dammAccounts: Map<string, Buffer>
let nftAccounts: { pubkey: PublicKey; data: Buffer }[]

function buildScenario(s: Scenario): void {
  scenario = s
  const pool = JSON.parse(JSON.stringify(s.damm.decoded))
  const accounts = new Map<string, Buffer>()
  nftAccounts = []
  for (const k of ['first', 'second'] as const) {
    const p = s.positions[k]
    if (!p || p.absent) continue
    const decoded = JSON.parse(JSON.stringify(p.decoded))
    if (s.preClaim && p.nftOwner === s.ids.creator) {
      pool.feeBPerLiquidity = decoded.feeBPerTokenCheckpoint // pool value at claim time
      decoded.feeBPerTokenCheckpoint = decoded.feeBPerTokenCheckpoint.map(() => 0)
      decoded.metrics.totalClaimedBFee = '0'
    }
    accounts.set(p.address, encodeAccount('Position', decoded))
    if (p.nftOwner === s.ids.creator && s.walletHoldsCreatorPosition) {
      const data = Buffer.alloc(AccountLayout.span)
      AccountLayout.encode(
        {
          mint: new PublicKey(p.nftMint),
          owner: new PublicKey(p.nftOwner),
          amount: 1n,
          delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
          delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
        } as never,
        data,
      )
      nftAccounts.push({ pubkey: new PublicKey(p.nftAccount), data })
    }
  }
  accounts.set(s.damm.address, encodeAccount('Pool', pool))
  dammAccounts = accounts
}

// ── Stubs ────────────────────────────────────────────────────────────────────
let mockMigrated = true
let mockMigrationFeeOption = 6
let mockCreatorQuoteFee = 0n
let mockCreatorShare = { creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 30 }
let claimCalls: Record<string, unknown>[] = []

const bnLike = (value: bigint | number) => ({ toString: () => String(value) })

function makeDeps(): ClaimDeps {
  const ids = scenario.ids
  const client = {
    state: {
      getPool: async () => ({
        config: new PublicKey(ids.config),
        baseMint: new PublicKey(ids.baseMint),
        creator: new PublicKey(ids.creator),
        creatorQuoteFee: bnLike(mockCreatorQuoteFee),
        creatorBaseFee: bnLike(0),
        isMigrated: mockMigrated ? 1 : 0,
        migrationProgress: mockMigrated ? 3 : 2,
      }),
      getPoolConfig: async () => ({
        migrationOption: 1,
        migrationFeeOption: mockMigrationFeeOption,
        quoteMint: new PublicKey(SKR),
        ...mockCreatorShare,
      }),
    },
    creator: {
      claimCreatorTradingFee: async (args: Record<string, unknown>) => {
        claimCalls.push(args)
        return new Transaction()
      },
    },
  } as unknown as DynamicBondingCurveClient
  return {
    connection: new Connection('http://127.0.0.1:1'),
    client,
    catalogDeps: {
      fetchMobileConfig: async () => ({
        cluster: 'mainnet-beta',
        geo: { region: 'US', restricted: [] },
        launchConfigOptions: { meme: [{ configKey: ids.config }] },
        version: 'test-v1',
      }),
    },
  }
}

const restores: (() => void)[] = []
function patch(key: string, fn: unknown): void {
  const proto = Connection.prototype as unknown as Record<string, unknown>
  const original = proto[key]
  proto[key] = fn
  restores.push(() => {
    proto[key] = original
  })
}
const accountInfo = (data: Buffer, owner: PublicKey) => ({
  data, owner, lamports: 1_000_000, executable: false, rentEpoch: 0,
})
const infoFor = (address: PublicKey) => {
  const data = dammAccounts.get(address.toBase58())
  return data ? accountInfo(data, CP_AMM_PROGRAM_ID) : null
}

beforeEach(() => {
  resetConfigCatalogCachesForTests()
  mockMigrated = true
  mockMigrationFeeOption = 6
  mockCreatorQuoteFee = 0n
  mockCreatorShare = { creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 30 }
  claimCalls = []
  buildScenario({
    ids: FLAT, damm: flatPool, positions: flatPositions, preClaim: true,
    walletHoldsCreatorPosition: true,
  })
  patch('getLatestBlockhash', async () => ({
    blockhash: '4uQeVj5tqViQh7yWWGStvkEG1RgTksVZc8k1q1iT1c1k',
    lastValidBlockHeight: 350_000_042,
  }))
  patch('simulateTransaction', async () => {
    throw new Error('simulateTransaction not available in tests')
  })
  patch('getRecentPrioritizationFees', async () => [])
  patch('getAccountInfo', async (a: PublicKey) => infoFor(a)) // ATAs absent -> created
  patch('getAccountInfoAndContext', async (a: PublicKey) => ({ context: { slot: 1 }, value: infoFor(a) }))
  patch('getMultipleAccountsInfoAndContext', async (as: PublicKey[]) => ({
    context: { slot: 1 },
    value: as.map(infoFor),
  }))
  patch('getTokenAccountsByOwner', async (owner: PublicKey) => ({
    context: { slot: 1 },
    value: owner.toBase58() === scenario.ids.creator
      ? nftAccounts.map((n) => ({ pubkey: n.pubkey, account: accountInfo(n.data, TOKEN_2022_PROGRAM_ID) }))
      : [],
  }))
})

afterEach(() => {
  while (restores.length) restores.pop()?.()
})

const request = (ids = FLAT, extra: Record<string, unknown> = {}) => ({
  poolAddress: ids.dbcPool, creatorPublicKey: ids.creator, ...extra,
})
async function rejectsWith(body: unknown, status: number, error: string, reason?: string): Promise<void> {
  await assert.rejects(prepareClaimTx(body, null, makeDeps()), (err: unknown) => {
    assert.ok(err instanceof ClaimError)
    assert.equal(err.status, status)
    assert.equal(err.fields.error, error)
    if (reason) assert.equal(err.fields.reason, reason)
    return true
  })
}

describe('fixture sanity', () => {
  it('the DAMM config the migrationFeeOption maps to derives the captured pools', () => {
    assert.equal(DAMM_V2_MIGRATION_FEE_ADDRESS[6].toBase58(), DAMM_CONFIG)
    for (const ids of [FLAT, CAUSE]) {
      const derived = deriveDammV2PoolAddress(
        DAMM_V2_MIGRATION_FEE_ADDRESS[6], new PublicKey(ids.baseMint), new PublicKey(SKR),
      )
      assert.equal(derived.toBase58(), ids.dammPool)
    }
    assert.equal(flatPool.address, FLAT.dammPool)
    assert.equal(causePool.address, CAUSE.dammPool)
  })

  it('the derived pre-claim state accrues exactly the real captured claim', () => {
    const checkpoint = leU256(flatPositions.second.decoded.feeBPerTokenCheckpoint)
    const liquidity = BigInt(flatPositions.second.decoded.permanentLockedLiquidity)
    assert.equal(((checkpoint * liquidity) >> 128n).toString(), CAPTURED_CLAIM_ATOMS)
  })
})

describe('prepareClaimTx source: "position"', () => {
  it('rejects an unknown source as a 400', async () => {
    await assert.rejects(
      prepareClaimTx(request(FLAT, { source: 'both' }), null, makeDeps()),
      (err: unknown) => err instanceof ClaimError && err.status === 400 && /source must be/.test(err.message),
    )
  })

  it('position-only: claims the creator position, accounts match the captured creator claim', async () => {
    const result = await prepareClaimTx(request(FLAT, { source: 'position' }), null, makeDeps())
    assert.equal(claimCalls.length, 0, 'the curve builder must not run')
    assert.equal(result.source, 'position')
    assert.equal(result.dammPool, FLAT.dammPool)
    assert.deepEqual(result.positions, [flatPositions.second.address])
    // base = token A (Token-2022 transfer-fee mint), quote = SKR (token B): fees accrue in B only.
    assert.deepEqual(result.claimable, { quoteAtoms: CAPTURED_CLAIM_ATOMS, baseAtoms: '0' })
    assert.equal(result.poolInfo.creator, FLAT.creator)
    assert.equal(result.lastValidBlockHeight, 350_000_042)

    const tx = Transaction.from(Buffer.from(result.transaction, 'base64'))
    assert.equal(tx.feePayer?.toBase58(), FLAT.creator)
    // Every emitted program is on the signing-review list the skill publishes.
    const documented = new Set<string>(
      JSON.parse(readFileSync(join(FIX, '..', '..', '..', 'public', 'skill.json'), 'utf8')).signing.programIds,
    )
    for (const ix of tx.instructions) {
      assert.ok(documented.has(ix.programId.toBase58()), `undocumented program ${ix.programId.toBase58()}`)
    }
    const ixs = tx.instructions.filter((i) => i.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111')

    // Captured: 2 createIdempotent ATAs (Token-2022 base, SPL quote) then claim_position_fee.
    const captured = claimTx.transaction.message.instructions.filter(
      (i: { programId: string }) => i.programId !== 'ComputeBudget111111111111111111111111111111',
    )
    assert.equal(ixs.length, captured.length)
    for (let i = 0; i < 2; i++) {
      assert.equal(ixs[i].programId.toBase58(), captured[i].programId)
      assert.equal(ixs[i].keys[1].pubkey.toBase58(), captured[i].parsed.info.account) // the ATA
      assert.equal(ixs[i].keys[3].pubkey.toBase58(), captured[i].parsed.info.mint)
      assert.equal(ixs[i].keys[5].pubkey.toBase58(), captured[i].parsed.info.tokenProgram)
    }
    const claim = ixs[2]
    const capturedClaim = captured[2]
    assert.equal(claim.programId.toBase58(), capturedClaim.programId)
    assert.deepEqual(claim.keys.map((k) => k.pubkey.toBase58()), capturedClaim.accounts)
    assert.equal(utils.bytes.bs58.encode(claim.data), capturedClaim.data)
    // Only the owner signs; the receiving ATAs are the claim's token accounts.
    assert.deepEqual(claim.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()), [FLAT.creator])
  })

  it('mixed: curve and position are two calls, each reporting only its own source', async () => {
    mockCreatorQuoteFee = 5_000_000n
    const curve = await prepareClaimTx(request(FLAT), null, makeDeps())
    assert.equal(claimCalls.length, 1)
    assert.deepEqual(curve.claimable, { quoteAtoms: '5000000', baseAtoms: '0' })
    assert.equal(curve.source, undefined, 'the curve response is unchanged')
    assert.equal(curve.dammPool, undefined)

    const position = await prepareClaimTx(request(FLAT, { source: 'position' }), null, makeDeps())
    assert.equal(claimCalls.length, 1, 'the position call does not touch the curve builder')
    assert.deepEqual(position.claimable, { quoteAtoms: CAPTURED_CLAIM_ATOMS, baseAtoms: '0' })
    assert.notEqual(position.transaction, curve.transaction)

    // an explicit "curve" is the same as the default
    const explicit = await prepareClaimTx(request(FLAT, { source: 'curve' }), null, makeDeps())
    assert.deepEqual(explicit.claimable, curve.claimable)
    assert.equal(claimCalls.length, 2)
  })

  it('empty: 409 only for the requested source', async () => {
    // Position source empty (creator claimed already: the captured post-claim state), curve non-empty.
    buildScenario({
      ids: FLAT, damm: flatPool, positions: flatPositions, preClaim: false,
      walletHoldsCreatorPosition: true,
    })
    // The captured pool predates the DAMM trades; align its fee value with the claimed checkpoint.
    const aligned = JSON.parse(JSON.stringify(flatPool.decoded))
    aligned.feeBPerLiquidity = flatPositions.second.decoded.feeBPerTokenCheckpoint
    dammAccounts.set(FLAT.dammPool, encodeAccount('Pool', aligned))
    mockCreatorQuoteFee = 5_000_000n
    await rejectsWith(request(FLAT, { source: 'position' }), 409, 'no_claimable_fees', 'no_fees_accrued')
    const curve = await prepareClaimTx(request(FLAT), null, makeDeps())
    assert.deepEqual(curve.claimable, { quoteAtoms: '5000000', baseAtoms: '0' })

    // Curve empty, position non-empty: the curve call refuses, the position call builds.
    buildScenario({
      ids: FLAT, damm: flatPool, positions: flatPositions, preClaim: true,
      walletHoldsCreatorPosition: true,
    })
    mockCreatorQuoteFee = 0n
    await rejectsWith(request(FLAT), 409, 'no_claimable_fees')
    const position = await prepareClaimTx(request(FLAT, { source: 'position' }), null, makeDeps())
    assert.equal(position.claimable.quoteAtoms, CAPTURED_CLAIM_ATOMS)
  })

  it('creator share but no position held in this wallet', async () => {
    buildScenario({
      ids: FLAT, damm: flatPool, positions: flatPositions, preClaim: true,
      walletHoldsCreatorPosition: false,
    })
    await rejectsWith(request(FLAT, { source: 'position' }), 409, 'no_claimable_fees', 'no_position_held')
  })

  it('no creator share (cause-only coin): 409 no_creator_share', async () => {
    buildScenario({
      ids: CAUSE, damm: causePool, positions: causePositions, preClaim: false,
      walletHoldsCreatorPosition: true,
    })
    mockCreatorShare = { creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 }
    await rejectsWith(request(CAUSE, { source: 'position' }), 409, 'no_claimable_fees', 'no_creator_share')
  })

  it('an unmapped migrationFeeOption is an explicit error, never a guess', async () => {
    mockMigrationFeeOption = 7
    await rejectsWith(request(FLAT, { source: 'position' }), 422, 'unmapped_migration_fee_option')
  })

  it('refuses a pool that has not migrated', async () => {
    mockMigrated = false
    await rejectsWith(request(FLAT, { source: 'position' }), 409, 'pool_not_migrated')
  })

  it('404s when the resolved DAMM pool does not exist', async () => {
    dammAccounts.delete(FLAT.dammPool)
    await rejectsWith(request(FLAT, { source: 'position' }), 404, 'damm_pool_not_found')
  })

  it('keeps the shared guards: wallet must be the DBC pool creator', async () => {
    await rejectsWith(
      { poolAddress: FLAT.dbcPool, creatorPublicKey: CAUSE.creator, source: 'position' },
      403,
      'not_creator',
    )
  })
})
