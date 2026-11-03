/**
 * LIVE mainnet check for the launch transaction builder — gated on
 * `LAUNCH_LIVE=1` so it never runs in the offline suite.
 *
 * Builds the real `createPool` transaction against the live production
 * config (DjLboXML…) via `buildLaunchTx` — real `getPoolConfig` decode,
 * token-badge lookup, latest blockhash, and the
 * `simulateTransaction` (sigVerify off) compute estimation inside
 * `applyEstimatedComputeBudget` — then asserts the serialized wire form:
 * a parseable legacy `Transaction`, mint signature present, payer slot
 * still empty.
 *
 * The payer is `LAUNCH_LIVE_PAYER` — a mainnet pubkey holding SOL (and, for
 * a first buy / non-SOL quote, enough quote token). Simulation runs with
 * sigVerify off + replaceRecentBlockhash and must succeed (err == null), so
 * the instructions actually execute. Skipped (never passed) when unset.
 *
 * Run with: `LAUNCH_LIVE=1 LAUNCH_LIVE_PAYER=<pubkey> node --test tests/launch-live.test.ts`
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ComputeBudgetProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { buildLaunchTx } from '../src/lib/dbc-launch.ts'
import { getConnection } from '../src/lib/dbc-shared.ts'
import { LIVE_CONFIG_KEY } from './helpers.ts'

const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'

const LIVE = process.env.LAUNCH_LIVE === '1'
const PAYER = process.env.LAUNCH_LIVE_PAYER
const SKIP: string | false = !LIVE
  ? 'set LAUNCH_LIVE=1 to run'
  : !PAYER
    ? 'set LAUNCH_LIVE_PAYER to a funded mainnet pubkey (SOL, plus quote token for a first buy)'
    : false

describe('buildLaunchTx against mainnet (LAUNCH_LIVE=1)', () => {
  it(
    'builds + simulates a createPool tx on the live config',
    { skip: SKIP, timeout: 90_000 },
    async () => {
    const payer = PAYER!
    const result = await buildLaunchTx({
      name: 'Agent Live Check',
      symbol: 'ALV',
      metadataUrl: 'https://ipfs.filebase.io/ipfs/bafkreiexample',
      payerAddress: payer,
      configKey: LIVE_CONFIG_KEY,
      quoteMint: SKR_MINT,
    })
    const tx = Transaction.from(Buffer.from(result.transaction, 'base64'))
    // Compute-budget instructions were prepended by the estimator.
    const budgetIxs = tx.instructions.filter((ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId),
    )
    assert.ok(budgetIxs.length >= 1, 'expected compute budget instructions')
    // The unit-limit request must be inside protocol bounds (data layout:
    // [u8 discriminator=2][u32 units LE]).
    const limitIx = budgetIxs.find((ix) => ix.data[0] === 2)
    assert.ok(limitIx, 'expected a SetComputeUnitLimit instruction')
    const units = limitIx!.data.readUInt32LE(1)
    assert.ok(units > 0 && units <= 1_400_000, `unit limit out of bounds: ${units}`)
    // Mint signature present; payer slot still unsigned.
    const mintSig = tx.signatures.find((s) => s.publicKey.toBase58() === result.mintAddress)
    const payerSig = tx.signatures.find((s) => s.publicKey.toBase58() === payer)
    assert.ok(mintSig?.signature, 'mint keypair signature missing')
    assert.equal(payerSig?.signature ?? null, null, 'payer slot must stay unsigned')
    assert.ok(result.poolAddress, 'pool address derived')
    // Funded payer + sigVerify off: the instructions must actually execute.
    const sim = await getConnection().simulateTransaction(
      new VersionedTransaction(tx.compileMessage()),
      { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
    )
    const errJson = JSON.stringify(sim.value.err)
    console.log('   [live] simulated unitsConsumed=%s err=%s', sim.value.unitsConsumed, errJson)
    assert.equal(sim.value.err, null, `simulation failed (logs: ${sim.value.logs?.slice(-6).join(' | ')}): ${errJson}`)
    },
  )
})
