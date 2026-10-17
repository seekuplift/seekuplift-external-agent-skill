/**
 * `buildLaunchTx` unit tests — the SQ-APP-3 token-badge wiring (Ticket 04).
 *
 * The DBC program requires the token-badge PDA as remaining account 0 for a
 * quote mint that isn't permissionless-supported (badged Token-2022 stock
 * quotes). SDK ≥1.5.13 attaches it from `createPoolParam.tokenBadge` but does
 * NOT look the badge up — the builder resolves it via
 * `client.state.getTokenBadge`, exactly as the app does
 * (dbc-launch-client.ts:630-638,674,749). These tests drive `buildLaunchTx`
 * with a stubbed DBC client + connection and assert:
 *
 *   - badge present for a badged quote mint in BOTH launch variants
 *     (`createPool` and `createPoolWithFirstBuy`);
 *   - badge absent for SKR (lookup runs, resolves undefined, and the param
 *     carries no `tokenBadge` key — the instruction payload is unchanged).
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  deriveTokenBadgeAddress,
  type DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchTx, FIRST_BUY_DEFAULT_SLIPPAGE_BPS } from '../src/lib/dbc-launch.ts'
import { DbcQuoteShapeError } from '../src/lib/dbc-shared.ts'
import { LIVE_CONFIG_KEY } from './helpers.ts'

const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
/** A real base58 mint standing in for a badged stock quote (e.g. AAPLx). */
const BADGED_QUOTE_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

const PAYER = Keypair.generate().publicKey.toBase58()

type Captured = {
  badgeLookups: string[]
  createPoolParam: Record<string, unknown> | null
  firstBuyParam: Record<string, unknown> | null
  quoteArgs: Record<string, unknown> | null
}

const bnLike = (value: bigint | number | string) => ({ toString: () => String(value) })

/** Mutable knobs for the first-buy quote seam (DD-S-2). */
const quoteControl: { result: Record<string, unknown> | null; config: unknown } = {
  // Default: a 2_000_000-atom output — the 50 bps floor is 1_990_000.
  result: { outputAmount: bnLike(2_000_000n) },
  config: { activationType: 0, enableFirstSwapWithMinFee: 1 },
}

/**
 * A DBC client double: `state.getTokenBadge` resolves per `badged`, and the
 * `creator` builders capture the params they were called with. The returned
 * transaction carries one instruction whose only signer is `baseMint`, so the
 * builder's `partialSign(mintKeypair)` has a real slot to sign.
 *
 * The first-buy quote seam (DD-S-2): `state.getPoolConfig` serves
 * `quoteControl.config`; `pool.getQuoteFromInputAmount` captures its args and
 * returns `quoteControl.result` — set `result` to `null` for a shape with no
 * output field.
 */
function fakeDbcClient(captured: Captured, badged: boolean): DynamicBondingCurveClient {
  const txWithMintSigner = (baseMint: PublicKey): Transaction =>
    new Transaction().add({
      programId: new PublicKey('11111111111111111111111111111111'),
      keys: [{ pubkey: baseMint, isSigner: true, isWritable: true }],
      data: Buffer.alloc(0),
    })
  return {
    state: {
      getTokenBadge: async (mint: PublicKey) => {
        captured.badgeLookups.push(mint.toBase58())
        return badged ? { tokenMint: mint } : null
      },
      getPoolConfig: async () => quoteControl.config,
    },
    pool: {
      getQuoteFromInputAmount: (args: Record<string, unknown>) => {
        captured.quoteArgs = args
        return quoteControl.result
      },
    },
    creator: {
      createPool: async (param: Record<string, unknown>) => {
        captured.createPoolParam = param
        return txWithMintSigner(param.baseMint as PublicKey)
      },
      createPoolWithFirstBuy: async (params: {
        createPoolParam: Record<string, unknown>
        firstBuyParam: Record<string, unknown>
      }) => {
        captured.createPoolParam = params.createPoolParam
        captured.firstBuyParam = params.firstBuyParam
        return txWithMintSigner(params.createPoolParam.baseMint as PublicKey)
      },
    },
  } as unknown as DynamicBondingCurveClient
}

/** A connection double: fixed blockhash, clean simulation, no fees. */
function fakeConnection(lastValidBlockHeight = 1): Connection {
  return {
    // getCurrentPoint reads the slot for activationType 0 (slot-based) configs.
    getSlot: async () => 1,
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight,
    }),
    simulateTransaction: async () => ({
      context: { slot: 1 },
      value: { err: null, unitsConsumed: 70_000, logs: [] },
    }),
    getRecentPrioritizationFees: async () => [],
  } as unknown as Connection
}

function baseParams(quoteMint: string, firstBuyAtoms?: bigint) {
  return {
    name: 'Badge Test Coin',
    symbol: 'BDG',
    metadataUrl: 'https://ipfs.filebase.io/ipfs/bafymeta',
    payerAddress: PAYER,
    configKey: LIVE_CONFIG_KEY,
    quoteMint,
    ...(firstBuyAtoms != null ? { firstBuyAtoms } : {}),
  }
}

describe('buildLaunchTx — token badge (SQ-APP-3)', () => {
  it('attaches the derived badge PDA to createPoolParam for a badged quote mint (createPool)', async () => {
    const captured: Captured = { badgeLookups: [], createPoolParam: null, firstBuyParam: null, quoteArgs: null }
    const result = await buildLaunchTx(baseParams(BADGED_QUOTE_MINT), {
      client: fakeDbcClient(captured, true),
      connection: fakeConnection(),
    })
    // The badge was looked up on the QUOTE mint (not the new base mint).
    assert.deepEqual(captured.badgeLookups, [BADGED_QUOTE_MINT])
    const param = captured.createPoolParam!
    const badge = param.tokenBadge as PublicKey
    assert.ok(badge instanceof PublicKey)
    assert.equal(
      badge.toBase58(),
      deriveTokenBadgeAddress(new PublicKey(BADGED_QUOTE_MINT)).toBase58(),
    )
    // Rest of the param mirrors the app payload.
    assert.equal((param.config as PublicKey).toBase58(), LIVE_CONFIG_KEY)
    assert.equal((param.payer as PublicKey).toBase58(), PAYER)
    assert.equal((param.poolCreator as PublicKey).toBase58(), PAYER)
    // The serialized tx round-trips with the mint signature present.
    const tx = Transaction.from(Buffer.from(result.transaction, 'base64'))
    assert.ok(
      tx.signatures.some((s) => s.publicKey.toBase58() === result.mintAddress && s.signature),
    )
    assert.equal(result.poolAddress.length > 0, true)
  })

  it('attaches the badge in createPoolWithFirstBuy too, with the atoms passed through', async () => {
    const captured: Captured = { badgeLookups: [], createPoolParam: null, firstBuyParam: null, quoteArgs: null }
    await buildLaunchTx(baseParams(BADGED_QUOTE_MINT, 5_000_000n), {
      client: fakeDbcClient(captured, true),
      connection: fakeConnection(),
    })
    assert.deepEqual(captured.badgeLookups, [BADGED_QUOTE_MINT])
    const param = captured.createPoolParam!
    assert.equal(
      (param.tokenBadge as PublicKey).toBase58(),
      deriveTokenBadgeAddress(new PublicKey(BADGED_QUOTE_MINT)).toBase58(),
    )
    const firstBuy = captured.firstBuyParam!
    assert.equal((firstBuy.buyer as PublicKey).toBase58(), PAYER)
    assert.equal((firstBuy.buyAmount as { toString(): string }).toString(), '5000000')
    assert.equal((firstBuy.minimumAmountOut as { toString(): string }).toString(), '1990000')
    assert.equal(firstBuy.referralTokenAccount, null)
  })

  it('resolves no badge for SKR — the param carries no tokenBadge key (createPool)', async () => {
    const captured: Captured = { badgeLookups: [], createPoolParam: null, firstBuyParam: null, quoteArgs: null }
    await buildLaunchTx(baseParams(SKR_MINT), {
      client: fakeDbcClient(captured, false),
      connection: fakeConnection(),
    })
    // The lookup still ran (the app rule: the program rejects badges on
    // supported mints, so a null result means "no badge on-chain").
    assert.deepEqual(captured.badgeLookups, [SKR_MINT])
    assert.equal('tokenBadge' in captured.createPoolParam!, false)
  })

  it('resolves no badge for SKR in createPoolWithFirstBuy either', async () => {
    const captured: Captured = { badgeLookups: [], createPoolParam: null, firstBuyParam: null, quoteArgs: null }
    await buildLaunchTx(baseParams(SKR_MINT, 1_000_000n), {
      client: fakeDbcClient(captured, false),
      connection: fakeConnection(),
    })
    assert.deepEqual(captured.badgeLookups, [SKR_MINT])
    assert.equal('tokenBadge' in captured.createPoolParam!, false)
    assert.equal(
      (captured.firstBuyParam!.buyAmount as { toString(): string }).toString(),
      '1000000',
    )
  })

  it('returns lastValidBlockHeight from the same getLatestBlockhash read as the blockhash (IV-S-1)', async () => {
    const captured: Captured = { badgeLookups: [], createPoolParam: null, firstBuyParam: null, quoteArgs: null }
    const result = await buildLaunchTx(baseParams(SKR_MINT), {
      client: fakeDbcClient(captured, false),
      connection: fakeConnection(350_000_042),
    })
    assert.equal(result.lastValidBlockHeight, 350_000_042)
    // … and the tx really carries that read's blockhash.
    const tx = Transaction.from(Buffer.from(result.transaction, 'base64'))
    assert.equal(tx.recentBlockhash, '11111111111111111111111111111111')
  })
})

describe('buildLaunchTx — first-buy output floor (DD-S-2)', () => {
  beforeEach(() => {
    quoteControl.result = { outputAmount: bnLike(2_000_000n) }
    quoteControl.config = { activationType: 0, enableFirstSwapWithMinFee: 1 }
  })

  function newCaptured(): Captured {
    return { badgeLookups: [], createPoolParam: null, firstBuyParam: null, quoteArgs: null }
  }

  it('derives minimumAmountOut from the simulated opening-curve quote at the default 50 bps', async () => {
    const captured = newCaptured()
    await buildLaunchTx(baseParams(SKR_MINT, 5_000_000n), {
      client: fakeDbcClient(captured, false),
      connection: fakeConnection(),
    })
    // The quote ran with the requested atoms on the chosen config.
    const quoteArgs = captured.quoteArgs!
    assert.equal((quoteArgs.amountIn as { toString(): string }).toString(), '5000000')
    assert.equal(quoteArgs.swapBaseForQuote, false)
    assert.equal(quoteArgs.slippageBps, FIRST_BUY_DEFAULT_SLIPPAGE_BPS)
    assert.equal(quoteArgs.eligibleForFirstSwapWithMinFee, true)
    // floor(2_000_000 × 9950 / 10_000) = 1_990_000 — not the old `1`.
    assert.equal(
      (captured.firstBuyParam!.minimumAmountOut as { toString(): string }).toString(),
      '1990000',
    )
  })

  it('honors a caller-supplied firstBuySlippageBps (10% floor)', async () => {
    const captured = newCaptured()
    await buildLaunchTx(
      { ...baseParams(SKR_MINT, 5_000_000n), firstBuySlippageBps: 1_000 },
      { client: fakeDbcClient(captured, false), connection: fakeConnection() },
    )
    assert.equal(captured.quoteArgs!.slippageBps, 1_000)
    // floor(2_000_000 × 9000 / 10_000) = 1_800_000
    assert.equal(
      (captured.firstBuyParam!.minimumAmountOut as { toString(): string }).toString(),
      '1800000',
    )
  })

  it('accepts the legacy amountOut field name', async () => {
    quoteControl.result = { amountOut: bnLike(1_000_000n) }
    const captured = newCaptured()
    await buildLaunchTx(baseParams(SKR_MINT, 5_000_000n), {
      client: fakeDbcClient(captured, false),
      connection: fakeConnection(),
    })
    assert.equal(
      (captured.firstBuyParam!.minimumAmountOut as { toString(): string }).toString(),
      '995000',
    )
  })

  it('throws DbcQuoteShapeError when the quote result has neither output field', async () => {
    quoteControl.result = { minimumAmountOut: bnLike(1n) }
    const captured = newCaptured()
    await assert.rejects(
      () =>
        buildLaunchTx(baseParams(SKR_MINT, 5_000_000n), {
          client: fakeDbcClient(captured, false),
          connection: fakeConnection(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof DbcQuoteShapeError, `expected DbcQuoteShapeError, got ${err}`)
        return true
      },
    )
    // The failing quote must not still build a transaction.
    assert.equal(captured.firstBuyParam, null)
  })

  it('floors the derived minimum at 1 atom when the quote output is zero', async () => {
    quoteControl.result = { outputAmount: bnLike(0n) }
    const captured = newCaptured()
    await buildLaunchTx(baseParams(SKR_MINT, 5_000_000n), {
      client: fakeDbcClient(captured, false),
      connection: fakeConnection(),
    })
    assert.equal(
      (captured.firstBuyParam!.minimumAmountOut as { toString(): string }).toString(),
      '1',
    )
  })

  it('throws when the config cannot be read for the quote', async () => {
    quoteControl.config = null
    const captured = newCaptured()
    await assert.rejects(
      () =>
        buildLaunchTx(baseParams(SKR_MINT, 5_000_000n), {
          client: fakeDbcClient(captured, false),
          connection: fakeConnection(),
        }),
      /config not found/,
    )
    assert.equal(captured.firstBuyParam, null)
  })
})
