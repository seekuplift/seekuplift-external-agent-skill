/**
 * LIVE mainnet check for the trade transaction builders — gated on
 * `TRADE_LIVE=1` so it never runs in the offline suite. Read-only mainnet
 * only: pool discovery, quotes, and `simulateTransaction` (legacy tx → the
 * client sends `sigVerify` unset, i.e. false) — no signing, no submission,
 * no spend.
 *
 * Discovers a pool still on the curve under the live production SKR config
 * (61UBwyZf…), quotes + builds a buy and a sell on it, then simulates both.
 * A swap only simulates cleanly when the unsigned `owner`'s input ATA holds
 * the input token. The owner is `TRADE_LIVE_OWNER` (a funded mainnet pubkey)
 * when set, otherwise the pool's known wallet candidates (`creator`,
 * `feeClaimer`, `leftoverReceiver`) are probed with per-address
 * `getTokenAccountBalance` reads. Simulation uses sigVerify off +
 * replaceRecentBlockhash and must return err == null. A side with no funded
 * owner is SKIPPED with a reason — never passed vacuously.
 *
 * Run with: `TRADE_LIVE=1 node --test tests/trade-live.test.ts`
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { getConnection, getDbcClient } from '../src/lib/dbc-shared.ts'
import { fetchDbcPoolRead, buildDbcSwapTx } from '../src/lib/dbc-trade.ts'
import { LIVE_CONFIG_KEY } from './helpers.ts'

const LIVE = process.env.TRADE_LIVE === '1'
const ENV_OWNER = process.env.TRADE_LIVE_OWNER
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

type Candidate = { owner: string; inputAta: string; balance: bigint }

/** Candidates whose input-mint ATA actually holds ≥ `amountIn`. */
async function fundedInputOwners(params: {
  candidates: string[]
  inputMint: PublicKey
  inputTokenProgram: PublicKey
  amountIn: bigint
}): Promise<Candidate[]> {
  const connection = getConnection()
  const out: Candidate[] = []
  for (const owner of params.candidates) {
    try {
      const ata = getAssociatedTokenAddressSync(
        params.inputMint,
        new PublicKey(owner),
        true,
        params.inputTokenProgram,
      )
      const balance = await connection.getTokenAccountBalance(ata, 'confirmed')
      const amount = BigInt(balance.value.amount)
      if (amount >= params.amountIn) {
        out.push({ owner, inputAta: ata.toString(), balance: amount })
      }
    } catch {
      // no ATA / unreadable → next candidate
    }
  }
  return out
}

describe('trade quote + tx simulation against mainnet (TRADE_LIVE=1)', () => {
  it(
    'quotes and simulates a buy and a sell on a live curve pool',
    { skip: LIVE ? false : 'set TRADE_LIVE=1 to run', timeout: 300_000 },
    async (t) => {
      const connection = getConnection()
      const unfunded: string[] = []
      const client = getDbcClient()

      // Discover a pool still on the curve under the live production config.
      const pools = await client.state.getPoolsByConfig(new PublicKey(LIVE_CONFIG_KEY))
      assert.ok(pools.length > 0, `no pools found under config ${LIVE_CONFIG_KEY}`)
      let read = null as Awaited<ReturnType<typeof fetchDbcPoolRead>> | null
      let state = null as Awaited<ReturnType<typeof import('../src/lib/dbc-shared.ts').getPoolAndConfig>> | null
      for (const entry of pools.slice(0, 25)) {
        const candidate = await fetchDbcPoolRead(entry.publicKey.toString())
        if (candidate.poolInfo.migrationState === 'curve') {
          read = candidate
          const { getPoolAndConfig } = await import('../src/lib/dbc-shared.ts')
          state = await getPoolAndConfig(client, entry.publicKey.toString())
          break
        }
      }
      assert.ok(read && state)
      const info = read.poolInfo
      const poolState = state.poolState as unknown as Record<string, { toString(): string }>
      const config = state.config as unknown as Record<string, unknown>
      console.log(
        `[trade-live] pool ${info.poolAddress} base ${info.baseMint} quote ${info.quoteMint} (${info.quoteSymbol})`,
      )

      // Wallet candidates that plausibly hold the pool's tokens.
      const candidates = [
        poolState.creator?.toString(),
        (config.feeClaimer as { toString(): string } | undefined)?.toString(),
        (config.leftoverReceiver as { toString(): string } | undefined)?.toString(),
      ].filter((v): v is string => typeof v === 'string' && v.length > 0)
      if (ENV_OWNER) candidates.unshift(ENV_OWNER)

      // The base mint's token program comes from the pool's tokenType; the
      // quote mint's from its account owner.
      const baseTokenProgram =
        config.tokenType === 1 ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID
      const quoteMintAccount = await connection.getAccountInfo(
        new PublicKey(info.quoteMint),
        'confirmed',
      )
      const quoteTokenProgram = quoteMintAccount?.owner ?? SPL_TOKEN_PROGRAM_ID

      async function simulateSide(params: {
        side: 'buy' | 'sell'
        inputMint: PublicKey
        inputTokenProgram: PublicKey
        amountIn: bigint
      }): Promise<void> {
        const quote = await read!.quote({
          swapBaseForQuote: params.side === 'sell',
          amountIn: params.amountIn,
        })
        console.log(
          `[trade-live] ${params.side} ${params.amountIn} atoms → ~${quote.amountOut} out (min ${quote.minimumAmountOut})`,
        )
        const discovered = await fundedInputOwners({
          candidates: candidates.filter((c) => c !== ENV_OWNER),
          inputMint: params.inputMint,
          inputTokenProgram: params.inputTokenProgram,
          amountIn: params.amountIn,
        })
        // TRADE_LIVE_OWNER is asserted funded by the operator (also covers
        // native-SOL inputs that have no token ATA).
        const funded = ENV_OWNER ? [{ owner: ENV_OWNER }, ...discovered] : discovered
        console.log(
          `[trade-live] ${params.side}: ${funded.length} funded candidate(s)`,
        )
        let lastErr: unknown = null
        for (const { owner } of funded) {
          const { transaction } = await buildDbcSwapTx({
            poolAddress: info.poolAddress,
            ownerAddress: owner,
            swapBaseForQuote: params.side === 'sell',
            amountIn: params.amountIn,
            minimumAmountOut: quote.minimumAmountOut,
          })
          const tx = Transaction.from(Buffer.from(transaction, 'base64'))
          const result = await connection.simulateTransaction(
            new VersionedTransaction(tx.compileMessage()),
            { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
          )
          lastErr = result.value.err
          if (result.value.err == null) {
            console.log(`[trade-live] ${params.side} simulated clean as ${owner}`)
            return
          }
        }
        if (funded.length > 0) {
          assert.fail(
            `${params.side} simulation failed for all funded owners; last=${JSON.stringify(lastErr)}`,
          )
        }
        unfunded.push(params.side)
      }

      // Small buy: a lamport-scale slice of the quote mint.
      const buyIn = BigInt(10) ** BigInt(Math.max(info.quoteDecimals - 3, 0))
      await simulateSide({
        side: 'buy',
        inputMint: new PublicKey(info.quoteMint),
        inputTokenProgram: quoteTokenProgram,
        amountIn: buyIn,
      })

      // Small sell: a fraction of the base mint.
      const sellIn = BigInt(10) ** BigInt(Math.max(info.baseDecimals - 3, 0))
      await simulateSide({
        side: 'sell',
        inputMint: new PublicKey(info.baseMint),
        inputTokenProgram: baseTokenProgram,
        amountIn: sellIn,
      })
      if (unfunded.length > 0) {
        t.skip(
          `no funded owner for ${unfunded.join('+')}; set TRADE_LIVE_OWNER to a mainnet pubkey holding the input token`,
        )
      }
    },
  )
})
