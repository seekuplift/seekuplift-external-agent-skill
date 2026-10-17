/**
 * Port of the app's `dbc-swap-client.test.mjs` trade sections, adapted to
 * this service's seams: the SDK client is injected through `deps.client`
 * (a hand-rolled stub recording the swap/quote calls) and RPC reads are
 * patched on `Connection.prototype`, exactly as the app tests do.
 *
 * Covers: QA-34 partial-fill buys vs full-fill sells, DBC-RF-1 gross
 * consumed/refund fields, TF-APP-1 Token-2022 transfer-fee net/gross math on
 * the captured 1%/10% mint fixtures, SQ-APP-4 ScaledUiAmount quote mints,
 * CA-A-5 migration-state derivation, and ISSUE-002 compute budgeting.
 */
import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import { SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  buildDbcSwapTx,
  DBC_SWAP_FALLBACK_COMPUTE_UNITS,
  fetchDbcPoolInfo,
  fetchDbcPoolRead,
  fetchDbcSwapQuote,
} from '../src/lib/dbc-trade.ts'
import {
  DbcQuoteShapeError,
  parseScaledUiAmountConfigFromRaw,
  ScaledUiDecodeError,
} from '../src/lib/dbc-shared.ts'
import { loadFixture } from './helpers.ts'

const POOL_ADDRESS = '9uFg8xPfLVVn92qeiNoBSURZdtSYYsByfp7id1WFVj3b'
const OWNER_ADDRESS = 'HWxH6KJk8u5fcMQgAZMv92mSzSHUDjPQHvRwhSS75dRj'
const BASE_MINT = 'EYhMhoZEMnr9EJUYAAU8TX4NNEaM12yNHW2xPUgyuZMc'
const QUOTE_MINT = 'So11111111111111111111111111111111111111112' // SOL
const CONFIG_ADDRESS = 'FEAmFp76ezVdR8wvSEtuHVEZw1QJ9MQoupDMcqXECbLD'
const GOOGLX_MINT = 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN'

const GOOGLX_FIXTURE = loadFixture<{
  parsedData: unknown
  rawAccountBase64: string
}>('googlx-mint-account.json')
const TF_MINT_100 = loadFixture<{ data: unknown }>('tf-flat-10-100-mint.json')
const TF_MINT_1000 = loadFixture<{ data: unknown }>('tf-flat-10-1000-mint.json')

// TF-DC-1 captures: 50_000_000 quote atoms bought this gross on both fee
// pools; the vault→trader transfer then withheld the fixture fees below.
const TF_GROSS_BUY_OUT = 692_787_266_924_219n
const TF_NET_BUY_OUT_100 = 685_859_394_254_976n
const TF_FEE_BUY_100 = 6_927_872_669_243n
const TF_NET_BUY_OUT_1000 = 623_508_540_231_797n
const TF_FEE_BUY_1000 = 69_278_726_692_422n
const TF_SELL_IN_100 = 342_929_697_127_488n
const TF_SELL_FEE_100 = 3_429_296_971_275n
const TF_SELL_IN_1000 = 311_754_270_115_898n
const TF_SELL_FEE_1000 = 31_175_427_011_590n

const bnLike = (value: bigint | number | string) => ({ toString: () => String(value) })

// ─── Mock client state (mutable per test) ───────────────────────────────────
let swapQuoteCalls: Record<string, unknown>[] = []
let swapQuote2Calls: Record<string, unknown>[] = []
let swapCalls: Record<string, unknown>[] = []
let swap2Calls: Record<string, unknown>[] = []
let mockPoolExists = true
let mockAmountLeft: bigint | null = null
let mockConsumedInput: bigint | null = null
let mockOutputAmount: bigint | null = null
let mockMinOut: bigint | null = null
let mockOmitOutputFields = false
let mockQuoteMint = QUOTE_MINT
let mockTokenType = 0
let mockQuoteReserve: bigint | number = 0
let mockIsMigrated: number | undefined = 0
let mockMigrationProgress: number | undefined = 0

function makeMockClient(): DynamicBondingCurveClient {
  return {
    state: {
      getPool: async () =>
        mockPoolExists
          ? {
              baseMint: new PublicKey(BASE_MINT),
              config: new PublicKey(CONFIG_ADDRESS),
              quoteReserve: bnLike(mockQuoteReserve),
              isMigrated: mockIsMigrated,
              migrationProgress: mockMigrationProgress,
            }
          : null,
      getPoolConfig: async () => ({
        quoteMint: new PublicKey(mockQuoteMint),
        migrationQuoteThreshold: bnLike(1_000_000_000),
        activationType: 0,
        tokenType: mockTokenType,
      }),
    },
    pool: {
      swapQuote: (args: Record<string, unknown>) => {
        swapQuoteCalls.push(args)
        const requested = (args.amountIn as { toString(): string }).toString()
        if (mockOmitOutputFields) {
          // DD-S-2: a result shape where the output field was renamed away.
          return {
            minimumAmountOut: bnLike(950_000n),
            includedFeeInputAmount: bnLike(requested),
            amountLeft: bnLike(0),
          }
        }
        return {
          outputAmount: bnLike(mockOutputAmount ?? 1_000_000n),
          minimumAmountOut: bnLike(mockMinOut ?? 950_000n),
          includedFeeInputAmount: bnLike(
            mockConsumedInput == null ? requested : mockConsumedInput,
          ),
          amountLeft: bnLike(0),
        }
      },
      swapQuote2: (args: Record<string, unknown>) => {
        swapQuote2Calls.push(args)
        const requested = (args.amountIn as { toString(): string }).toString()
        if (mockOmitOutputFields) {
          return {
            minimumAmountOut: bnLike(855_000n),
            includedFeeInputAmount: bnLike(requested),
            amountLeft: bnLike(mockAmountLeft == null ? 0n : mockAmountLeft),
          }
        }
        return {
          outputAmount: bnLike(mockOutputAmount ?? 900_000n),
          minimumAmountOut: bnLike(mockMinOut ?? 855_000n),
          includedFeeInputAmount: bnLike(
            mockConsumedInput == null ? requested : mockConsumedInput,
          ),
          amountLeft: bnLike(mockAmountLeft == null ? 0n : mockAmountLeft),
        }
      },
      swap: async (args: Record<string, unknown>) => {
        swapCalls.push(args)
        return new Transaction()
      },
      swap2: async (args: Record<string, unknown>) => {
        swap2Calls.push(args)
        return new Transaction()
      },
    },
  } as unknown as DynamicBondingCurveClient
}

const connection = new Connection('http://127.0.0.1:1')
const deps = () => ({ connection, client: makeMockClient() })

// ─── Connection.prototype patching ──────────────────────────────────────────
type Restore = () => void
const restores: Restore[] = []

function patch<K extends keyof Connection>(key: K, fn: unknown): void {
  const proto = Connection.prototype as unknown as Record<string, unknown>
  const original = proto[key as string]
  proto[key as string] = fn
  restores.push(() => {
    proto[key as string] = original
  })
}

beforeEach(() => {
  swapQuoteCalls = []
  swapQuote2Calls = []
  swapCalls = []
  swap2Calls = []
  mockPoolExists = true
  mockAmountLeft = null
  mockConsumedInput = null
  mockOutputAmount = null
  mockMinOut = null
  mockOmitOutputFields = false
  mockQuoteMint = QUOTE_MINT
  mockTokenType = 0
  mockQuoteReserve = 0
  mockIsMigrated = 0
  mockMigrationProgress = 0
  // Default RPC reads: slot for getCurrentPoint, blockhash for the tx path.
  patch('getSlot', async () => 1)
  patch('getLatestBlockhash', async () => ({
    blockhash: '4uQeVj5tqViQh7yWWGStvkEG1RgTksVZc8k1q1iT1c1k',
    lastValidBlockHeight: 1,
  }))
})

afterEach(() => {
  while (restores.length) restores.pop()?.()
})

/** Patch the mint read: `handler(mint)` → parsed `data` value (or null). */
function patchMintReads(handler: (mint: PublicKey) => unknown): void {
  patch('getParsedAccountInfo', async (mint: PublicKey) => ({
    value: { data: handler(mint) },
  }))
  patch('getAccountInfo', async () => null)
}

/** Ordinary decimals-only mint read for both mints (no extensions). */
function patchDecimals(): void {
  patchMintReads((mint) => ({
    parsed: { info: { decimals: mint.toString() === BASE_MINT ? 8 : 9 } },
  }))
}

/** Patch the budget RPC pair; defaults fail estimation → fallback/floor. */
function patchBudgetRpc(overrides?: {
  simulate?: () => unknown
  fees?: () => { slot: number; prioritizationFee: number }[]
}): void {
  patch('simulateTransaction', async () => {
    if (overrides?.simulate) return overrides.simulate()
    throw new Error('simulateTransaction not available in tests')
  })
  patch('getRecentPrioritizationFees', async () => overrides?.fees?.() ?? [])
}

const simulateOk = (unitsConsumed: number) => ({
  context: { slot: 0 },
  value: { err: null, logs: [], unitsConsumed },
})

/** Decode the leading SetComputeUnitLimit + SetComputeUnitPrice pair. */
function budgetPair(tx: Transaction): { units: number; microLamports: bigint } {
  const [limitIx, priceIx] = tx.instructions
  assert.ok(limitIx, 'first instruction must exist (setComputeUnitLimit)')
  assert.ok(priceIx, 'second instruction must exist (setComputeUnitPrice)')
  assert.equal(limitIx.programId.toString(), ComputeBudgetProgram.programId.toString())
  assert.equal(priceIx.programId.toString(), ComputeBudgetProgram.programId.toString())
  assert.equal(limitIx.data[0], 2)
  assert.equal(priceIx.data[0], 3)
  return {
    units: limitIx.data.readUInt32LE(1),
    microLamports: priceIx.data.readBigUInt64LE(1),
  }
}

const feeBudgetCap = (units: number) => Math.floor((100_000 * 1e6) / units)

// ─── fetchDbcSwapQuote (QA-34 / DBC-RF-1) ────────────────────────────────────
describe('fetchDbcSwapQuote', () => {
  it('uses swapQuote2 with SwapMode.PartialFill for buys and derives the gross refund (DBC-RF-1)', async () => {
    // A threshold-crossing buy under input fees: the SDK's raw remainder is a
    // NET 90_000 atoms while the gross consumed input is 1_900_000 of the
    // requested 2_000_000. The surfaced refund must be the GROSS remainder.
    mockAmountLeft = 90_000n
    mockConsumedInput = 1_900_000n
    const result = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: false, amountIn: 2_000_000n },
      deps(),
    )
    assert.equal(swapQuote2Calls.length, 1, 'buy quote must use pool.swapQuote2')
    assert.equal(swapQuoteCalls.length, 0, 'buy quote must NOT use the full-fill swapQuote')
    const args = swapQuote2Calls[0]
    assert.equal(args.swapMode, SwapMode.PartialFill)
    assert.equal(args.swapBaseForQuote, false)
    assert.equal(result.consumedInput, 1_900_000n, 'gross consumed input must be surfaced')
    assert.equal(result.amountLeft, 100_000n, 'gross refund = requested − consumed')
    assert.equal(result.amountLeftNet, 90_000n, 'raw net remainder preserved separately')
    assert.equal(result.amountOut, 900_000n)
  })

  it('falls back to full-fill semantics when the SDK shape omits includedFeeInputAmount', async () => {
    mockAmountLeft = 0n
    const result = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: false, amountIn: 2_000_000n },
      deps(),
    )
    assert.equal(result.consumedInput, 2_000_000n)
    assert.equal(result.amountLeft, 0n)
    assert.equal(result.amountLeftNet, 0n)
  })

  it('uses the full-fill swapQuote for sells (no PartialFill)', async () => {
    const result = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: true, amountIn: 1_000_000n },
      deps(),
    )
    assert.equal(swapQuoteCalls.length, 1, 'sell quote must use the full-fill swapQuote')
    assert.equal(swapQuote2Calls.length, 0, 'sell quote must NOT use swapQuote2')
    assert.equal(result.consumedInput, 1_000_000n)
    assert.equal(result.amountLeft, 0n)
  })

  it('throws DbcQuoteShapeError when the result carries neither output field (DD-S-2)', async () => {
    mockOmitOutputFields = true
    for (const swapBaseForQuote of [false, true]) {
      await assert.rejects(
        () =>
          fetchDbcSwapQuote(
            { poolAddress: POOL_ADDRESS, swapBaseForQuote, amountIn: 1_000_000n },
            deps(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof DbcQuoteShapeError, `expected DbcQuoteShapeError, got ${err}`)
          assert.match(err.message, /outputAmount|amountOut/)
          return true
        },
      )
    }
  })
})

// ─── buildDbcSwapTx (QA-34 / ISSUE-002) ──────────────────────────────────────
describe('buildDbcSwapTx', () => {
  it('uses swap2 with SwapMode.PartialFill for buys', async () => {
    patchBudgetRpc()
    const { transaction } = await buildDbcSwapTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerAddress: OWNER_ADDRESS,
        swapBaseForQuote: false,
        amountIn: 2_000_000n,
        minimumAmountOut: 950_000n,
      },
      deps(),
    )
    assert.equal(swap2Calls.length, 1, 'buy tx must be built with pool.swap2')
    assert.equal(swapCalls.length, 0, 'buy tx must NOT use the full-fill pool.swap')
    const args = swap2Calls[0]
    assert.equal(args.swapMode, SwapMode.PartialFill)
    assert.equal(args.swapBaseForQuote, false)
    const tx = Transaction.from(Buffer.from(transaction, 'base64'))
    assert.equal(tx.feePayer?.toString(), OWNER_ADDRESS)
  })

  it('uses the full-fill pool.swap for sells', async () => {
    patchBudgetRpc()
    await buildDbcSwapTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerAddress: OWNER_ADDRESS,
        swapBaseForQuote: true,
        amountIn: 1_000_000n,
        minimumAmountOut: 950_000n,
      },
      deps(),
    )
    assert.equal(swapCalls.length, 1, 'sell tx must use the full-fill pool.swap')
    assert.equal(swap2Calls.length, 0, 'sell tx must NOT use pool.swap2')
  })

  it('ISSUE-002: budgets the swap from simulated CU consumption with the lamport cap binding', async () => {
    patchBudgetRpc({
      simulate: () => simulateOk(41_851),
      fees: () =>
        Array.from({ length: 5 }, (_, i) => ({ slot: i + 1, prioritizationFee: 2_000_000 })),
    })
    const { transaction } = await buildDbcSwapTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerAddress: OWNER_ADDRESS,
        swapBaseForQuote: false,
        amountIn: 2_000_000n,
        minimumAmountOut: 950_000n,
      },
      deps(),
    )
    const { units, microLamports } = budgetPair(Transaction.from(Buffer.from(transaction, 'base64')))
    assert.equal(units, Math.ceil(41_851 * 1.3), 'limit must be ceil(unitsConsumed × 1.3)')
    assert.equal(microLamports, BigInt(feeBudgetCap(units)), 'price must be capped by the lamport budget')
  })

  it('ISSUE-002: falls back to the static swap constant and floor price when estimation fails', async () => {
    patchBudgetRpc() // simulate throws, fees: [] → floor
    const { transaction } = await buildDbcSwapTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerAddress: OWNER_ADDRESS,
        swapBaseForQuote: true,
        amountIn: 1_000_000n,
        minimumAmountOut: 950_000n,
      },
      deps(),
    )
    const { units, microLamports } = budgetPair(Transaction.from(Buffer.from(transaction, 'base64')))
    assert.equal(units, DBC_SWAP_FALLBACK_COMPUTE_UNITS)
    assert.equal(microLamports, 1_000n, 'price must be the floor when no samples are available')
  })

  it('returns lastValidBlockHeight from the same getLatestBlockhash read as the blockhash (IV-S-1)', async () => {
    patchBudgetRpc()
    patch('getLatestBlockhash', async () => ({
      blockhash: '4uQeVj5tqViQh7yWWGStvkEG1RgTksVZc8k1q1iT1c1k',
      lastValidBlockHeight: 350_000_042,
    }))
    const { transaction, lastValidBlockHeight } = await buildDbcSwapTx(
      {
        poolAddress: POOL_ADDRESS,
        ownerAddress: OWNER_ADDRESS,
        swapBaseForQuote: false,
        amountIn: 2_000_000n,
        minimumAmountOut: 950_000n,
      },
      deps(),
    )
    assert.equal(lastValidBlockHeight, 350_000_042)
    const tx = Transaction.from(Buffer.from(transaction, 'base64'))
    assert.equal(tx.recentBlockhash, '4uQeVj5tqViQh7yWWGStvkEG1RgTksVZc8k1q1iT1c1k')
  })
})

// ─── SQ-APP-4: scaled (Token-2022) quote mints ───────────────────────────────
describe('fetchDbcPoolInfo — ScaledUiAmount quote mint (SQ-APP-4)', () => {
  it("carries the quote mint's scaledUiAmountConfig into DbcPoolInfo", async () => {
    mockQuoteMint = GOOGLX_MINT
    patchMintReads((mint) =>
      mint.toString() === BASE_MINT
        ? { parsed: { info: { decimals: 8 } } }
        : GOOGLX_FIXTURE.parsedData,
    )
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.quoteMint, GOOGLX_MINT)
    assert.equal(info.quoteDecimals, 8)
    assert.ok(info.quoteScaledUiAmount)
    assert.equal(info.quoteScaledUiAmount?.multiplier, '1.001926722393864')
    assert.equal(info.quoteScaledUiAmount?.newMultiplier, '1.0023772500603487')
    assert.equal(info.quoteScaledUiAmount?.newMultiplierEffectiveTimestamp, 1788481800)
  })

  it('reads the raw mint bytes when the parsed response is unusable', async () => {
    mockQuoteMint = GOOGLX_MINT
    patch('getParsedAccountInfo', async (mint: PublicKey) => ({
      value: {
        data:
          mint.toString() === BASE_MINT
            ? { parsed: { info: { decimals: 8 } } }
            : Buffer.alloc(0),
      },
    }))
    patch('getAccountInfo', async (mint: PublicKey) =>
      mint.toString() === GOOGLX_MINT
        ? { data: Buffer.from(GOOGLX_FIXTURE.rawAccountBase64, 'base64') }
        : null,
    )
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.quoteDecimals, 8)
    assert.ok(info.quoteScaledUiAmount)
    assert.equal(info.quoteScaledUiAmount?.multiplier, '1.001926722393864')
  })

  it('fails the pool read when a possibly-scaled quote mint is undecodable', async () => {
    mockQuoteMint = GOOGLX_MINT
    patchMintReads((mint) =>
      mint.toString() === BASE_MINT ? { parsed: { info: { decimals: 8 } } } : null,
    )
    await assert.rejects(() => fetchDbcPoolInfo(POOL_ADDRESS, deps()), /Unable to resolve mint info/)
  })

  it('skips the mint read for a registered SPL quote mint (SOL)', async () => {
    let parsedCalls = 0
    patch('getParsedAccountInfo', async (mint: PublicKey) => {
      parsedCalls += 1
      return {
        value: {
          data:
            mint.toString() === BASE_MINT ? { parsed: { info: { decimals: 8 } } } : null,
        },
      }
    })
    patch('getAccountInfo', async () => null)
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.quoteMint, QUOTE_MINT)
    assert.equal(info.quoteScaledUiAmount, null)
    // Only the BASE mint needed an RPC — the SOL quote mint skips it.
    assert.equal(parsedCalls, 1)
  })
})

// ─── TF-APP-1: base-mint transfer fees ───────────────────────────────────────
describe('fetchDbcSwapQuote — base-mint transfer fee (TF-APP-1)', () => {
  function patchFeeMint(mintData: unknown, epoch = 0): void {
    patch('getParsedAccountInfo', async (mint: PublicKey) => ({
      value: { data: mint.toString() === BASE_MINT ? mintData : null },
    }))
    patch('getAccountInfo', async () => null)
    patch('getEpochInfo', async () => ({ epoch }) as never)
  }

  beforeEach(() => {
    mockTokenType = 1
  })

  it('buy at 10% returns the captured net output and derives min-out from net', async () => {
    mockOutputAmount = TF_GROSS_BUY_OUT
    mockMinOut = 999n // sentinel: a gross-derived floor must NOT pass through
    patchFeeMint(TF_MINT_1000.data)
    const result = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: false, amountIn: 50_000_000n },
      deps(),
    )
    assert.equal(result.amountOut, TF_NET_BUY_OUT_1000, 'buy output is curve output minus the fee')
    assert.equal(result.baseTransferFeeAtomics, TF_FEE_BUY_1000, 'matches the on-chain capture')
    assert.equal(result.minimumAmountOut, (TF_NET_BUY_OUT_1000 * 9_950n) / 10_000n)
    assert.notEqual(result.minimumAmountOut, 999n, 'the SDK gross floor must not be returned')
    const args = swapQuote2Calls[0]
    assert.equal((args.amountIn as { toString(): string }).toString(), '50000000',
      'the curve is still quoted on the gross quote input')
  })

  it('buy at 1% returns the captured net output', async () => {
    mockOutputAmount = TF_GROSS_BUY_OUT
    patchFeeMint(TF_MINT_100.data)
    const result = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: false, amountIn: 50_000_000n },
      deps(),
    )
    assert.equal(result.amountOut, TF_NET_BUY_OUT_100)
    assert.equal(result.baseTransferFeeAtomics, TF_FEE_BUY_100)
    assert.equal(result.minimumAmountOut, (TF_NET_BUY_OUT_100 * 9_950n) / 10_000n)
  })

  it('sell at 10% quotes the curve on the fee-excluded vault receipt', async () => {
    patchFeeMint(TF_MINT_1000.data)
    const result = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: true, amountIn: TF_SELL_IN_1000 },
      deps(),
    )
    const args = swapQuoteCalls[0]
    assert.equal(
      (args.amountIn as { toString(): string }).toString(),
      String(TF_SELL_IN_1000 - TF_SELL_FEE_1000),
      'the curve only sees what the vault receives',
    )
    assert.equal(result.baseTransferFeeAtomics, TF_SELL_FEE_1000)
    assert.equal(result.amountOut, 1_000_000n)
    assert.equal(result.minimumAmountOut, 950_000n)
    assert.equal(result.consumedInput, TF_SELL_IN_1000, 'consumed stays in the gross units')
    assert.equal(result.amountLeft, 0n)
  })

  it('sell at 1% quotes the curve on the fee-excluded vault receipt', async () => {
    patchFeeMint(TF_MINT_100.data)
    const result = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: true, amountIn: TF_SELL_IN_100 },
      deps(),
    )
    const args = swapQuoteCalls[0]
    assert.equal(
      (args.amountIn as { toString(): string }).toString(),
      String(TF_SELL_IN_100 - TF_SELL_FEE_100),
    )
    assert.equal(result.baseTransferFeeAtomics, TF_SELL_FEE_100)
    assert.equal(result.consumedInput, TF_SELL_IN_100)
  })

  it('selects the fee entry for the CURRENT epoch (newer takes over at its epoch)', async () => {
    const scheduled = {
      parsed: {
        info: {
          decimals: 6,
          extensions: [
            {
              extension: 'transferFeeConfig',
              state: {
                olderTransferFee: {
                  epoch: '0',
                  maximumFee: '18446744073709551615',
                  transferFeeBasisPoints: 100,
                },
                newerTransferFee: {
                  epoch: '50',
                  maximumFee: '18446744073709551615',
                  transferFeeBasisPoints: 1000,
                },
                withheldAmount: '0',
              },
            },
          ],
        },
      },
    }
    mockOutputAmount = TF_GROSS_BUY_OUT
    for (const [epoch, expectedFee] of [
      [49, TF_FEE_BUY_100],
      [50, TF_FEE_BUY_1000],
    ] as const) {
      patchFeeMint(scheduled, epoch)
      const result = await fetchDbcSwapQuote(
        { poolAddress: POOL_ADDRESS, swapBaseForQuote: false, amountIn: 50_000_000n },
        deps(),
      )
      assert.equal(result.baseTransferFeeAtomics, expectedFee, `epoch ${epoch} picks the right entry`)
      restores.pop()?.() // undo the getEpochInfo patch for the next iteration
      restores.pop()?.() // undo getAccountInfo
      restores.pop()?.() // undo getParsedAccountInfo
    }
  })

  it('treats a Token-2022 mint WITHOUT the extension as fee-free (byte-identical)', async () => {
    patchFeeMint({ parsed: { info: { decimals: 6, extensions: [] } } })
    patch('getEpochInfo', async () => {
      throw new Error('getEpochInfo must not run for a fee-free mint')
    })
    const result = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: false, amountIn: 2_000_000n },
      deps(),
    )
    assert.equal(result.amountOut, 900_000n)
    assert.equal(result.minimumAmountOut, 855_000n)
    assert.equal(result.baseTransferFeeAtomics, 0n)
    assert.equal(result.consumedInput, 2_000_000n)
  })

  it('keeps an SPL base mint byte-identical AND skips the mint read entirely', async () => {
    mockTokenType = 0
    patch('getParsedAccountInfo', async () => {
      throw new Error('SPL pools must not read the mint for fees')
    })
    patch('getEpochInfo', async () => {
      throw new Error('SPL pools must not read the epoch')
    })
    const sell = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: true, amountIn: 1_000_000n },
      deps(),
    )
    assert.equal(sell.amountOut, 1_000_000n)
    assert.equal(sell.minimumAmountOut, 950_000n)
    assert.equal(sell.baseTransferFeeAtomics, 0n)
    const sellArgs = swapQuoteCalls[0]
    assert.equal((sellArgs.amountIn as { toString(): string }).toString(), '1000000')
    const buy = await fetchDbcSwapQuote(
      { poolAddress: POOL_ADDRESS, swapBaseForQuote: false, amountIn: 2_000_000n },
      deps(),
    )
    assert.equal(buy.amountOut, 900_000n)
    assert.equal(buy.minimumAmountOut, 855_000n)
  })

  it('reuses the fee config a pool read already surfaced (fetchDbcPoolRead.quote)', async () => {
    let mintReads = 0
    patch('getParsedAccountInfo', async (mint: PublicKey) => {
      mintReads += 1
      return {
        value: {
          data: mint.toString() === BASE_MINT ? TF_MINT_1000.data : null,
        },
      }
    })
    patch('getAccountInfo', async () => null)
    patch('getEpochInfo', async () => ({ epoch: 0 }) as never)
    mockOutputAmount = TF_GROSS_BUY_OUT
    const read = await fetchDbcPoolRead(POOL_ADDRESS, deps())
    assert.ok(read.poolInfo.baseTransferFee)
    const quote = await read.quote({ swapBaseForQuote: false, amountIn: 50_000_000n })
    assert.equal(quote.amountOut, TF_NET_BUY_OUT_1000)
    assert.equal(quote.baseTransferFeeAtomics, TF_FEE_BUY_1000)
    assert.equal(mintReads, 1, 'the quote reuses the pool read — no second mint fetch')
  })
})

describe('fetchDbcPoolInfo — transfer-fee mints (TF-APP-1)', () => {
  it("carries the base mint's transferFeeConfig into DbcPoolInfo", async () => {
    mockTokenType = 1
    patchMintReads((mint) =>
      mint.toString() === BASE_MINT
        ? TF_MINT_1000.data
        : { parsed: { info: { decimals: 9 } } },
    )
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.ok(info.baseTransferFee)
    assert.equal(info.baseTransferFee?.newerTransferFee.transferFeeBasisPoints, 1000)
    assert.equal(info.baseTransferFee?.newerTransferFee.maximumFee, (1n << 64n) - 1n)
    assert.equal(info.baseDecimals, 6, 'decimals come from the same mint read')
  })

  it('fails closed when the QUOTE mint carries a transfer fee', async () => {
    mockQuoteMint = GOOGLX_MINT // any non-registered mint forces the quote-mint read
    patchMintReads((mint) =>
      mint.toString() === BASE_MINT
        ? { parsed: { info: { decimals: 8 } } }
        : TF_MINT_100.data,
    )
    await assert.rejects(
      () => fetchDbcPoolInfo(POOL_ADDRESS, deps()),
      /QUOTE_MINT_TRANSFER_FEE_UNSUPPORTED/,
    )
  })
})

// ─── CA-A-5: migration state from the pool's own flags ───────────────────────
describe('fetchDbcPoolInfo — migration state (CA-A-5)', () => {
  it('ordinary curve: reserve below threshold, flags at PreBondingCurve → curve', async () => {
    mockQuoteReserve = 500_000_000n
    patchDecimals()
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.migrationState, 'curve')
    assert.equal(info.isCompleted, false)
  })

  it('migrated flag wins even with DRAINED reserves → migrated', async () => {
    mockIsMigrated = 1
    mockMigrationProgress = 3
    mockQuoteReserve = 0n
    patchDecimals()
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.migrationState, 'migrated')
    assert.equal(info.isCompleted, true)
  })

  it('terminal progress (CreatedPool) selects migrated even when the flag byte reads 0', async () => {
    mockIsMigrated = 0
    mockMigrationProgress = 3
    mockQuoteReserve = 0n
    patchDecimals()
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.migrationState, 'migrated')
    assert.equal(info.isCompleted, true)
  })

  it('full reserve WITHOUT the migrated flag → migration_pending, not migrated', async () => {
    mockQuoteReserve = 1_000_000_000n // == mocked threshold
    patchDecimals()
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.migrationState, 'migration_pending')
    assert.equal(info.isCompleted, true, 'curve-unavailable compat still set')
  })

  for (const progress of [1, 2]) {
    it(`intermediate progress ${progress} (PostBondingCurve/LockedVesting) → migration_pending`, async () => {
      mockMigrationProgress = progress
      mockQuoteReserve = 1_000_000_000n
      patchDecimals()
      const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
      assert.equal(info.migrationState, 'migration_pending')
    })
  }

  it('an enum value outside the pinned set → migration_pending (fail closed)', async () => {
    mockMigrationProgress = 99
    patchDecimals()
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.migrationState, 'migration_pending')
    assert.equal(info.isCompleted, true)
  })

  it('missing migration flags on an otherwise ordinary pool → migration_pending (fail closed)', async () => {
    mockIsMigrated = undefined
    mockMigrationProgress = undefined
    patchDecimals()
    const info = await fetchDbcPoolInfo(POOL_ADDRESS, deps())
    assert.equal(info.migrationState, 'migration_pending')
    assert.equal(info.isCompleted, true)
  })
})

describe('ScaledUiAmount raw decode fails closed', () => {
  function rawMint(multiplier: number, len = 56): Uint8Array {
    const buf = Buffer.alloc(166 + 4 + len)
    buf.writeUInt16LE(25, 166)
    buf.writeUInt16LE(len, 168)
    if (len === 56) {
      buf.writeDoubleLE(multiplier, 170 + 32)
      buf.writeDoubleLE(multiplier, 170 + 48)
    }
    return buf
  }

  it('formats tiny/huge f64 multipliers without exponent notation', () => {
    assert.equal(parseScaledUiAmountConfigFromRaw(rawMint(1e-7))?.multiplier, '0.0000001')
    assert.equal(parseScaledUiAmountConfigFromRaw(rawMint(1e21))?.multiplier, '1000000000000000000000')
  })

  it('throws when the extension is present but the multiplier is undecodable', () => {
    assert.throws(() => parseScaledUiAmountConfigFromRaw(rawMint(NaN)), ScaledUiDecodeError)
    assert.throws(() => parseScaledUiAmountConfigFromRaw(rawMint(0)), ScaledUiDecodeError)
    assert.throws(() => parseScaledUiAmountConfigFromRaw(rawMint(1, 8)), ScaledUiDecodeError)
  })

  it('still returns null for a mint without the extension', () => {
    assert.equal(parseScaledUiAmountConfigFromRaw(Buffer.alloc(170)), null)
  })
})
