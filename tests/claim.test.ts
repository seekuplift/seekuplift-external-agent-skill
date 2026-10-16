/**
 * `/api/claim/tx` tests — `prepareClaimTx` in src/lib/claim.ts — driven
 * through a stub SDK client, prototype-patched Connection reads, and a
 * fixture mobile-config fetch. Asserts the app's claim guards: served
 * config only, creator must match, empty buckets refuse, and the built
 * claim asks for the full claimable amounts with the creator paying.
 */
import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { ClaimError, prepareClaimTx, type ClaimDeps } from '../src/lib/claim.ts'
import { resetConfigCatalogCachesForTests } from '../src/lib/config-catalog.ts'

const POOL_ADDRESS = '9uFg8xPfLVVn92qeiNoBSURZdtSYYsByfp7id1WFVj3b'
const CREATOR = 'HWxH6KJk8u5fcMQgAZMv92mSzSHUDjPQHvRwhSS75dRj'
const OTHER_WALLET = 'FdrDZPcYEjdB3nQGUgL7muXj4SBTzbAMMvMosufdtun1'
const BASE_MINT = 'EYhMhoZEMnr9EJUYAAU8TX4NNEaM12yNHW2xPUgyuZMc'
const CONFIG_ADDRESS = 'FEAmFp76ezVdR8wvSEtuHVEZw1QJ9MQoupDMcqXECbLD'
const UNSERVED_CONFIG = '4w9Rs2ewNJte2c4FGmQHM8fycv8vWzkjv3qzANuJ2rPT'

const bnLike = (value: bigint | number) => ({ toString: () => String(value) })

let mockPool: 'missing' | 'not-a-pool' | 'present' = 'present'
let mockConfig = CONFIG_ADDRESS
let mockQuoteFee = 5_000_000n
let mockBaseFee = 0n
let claimCalls: Record<string, unknown>[] = []

function makeDeps(): ClaimDeps {
  const client = {
    state: {
      getPool: async () => {
        if (mockPool === 'not-a-pool') throw new Error('Invalid account discriminator')
        if (mockPool === 'missing') return null
        return {
          config: new PublicKey(mockConfig),
          baseMint: new PublicKey(BASE_MINT),
          creator: new PublicKey(CREATOR),
          creatorQuoteFee: bnLike(mockQuoteFee),
          creatorBaseFee: bnLike(mockBaseFee),
        }
      },
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
        launchConfigOptions: { meme: [{ configKey: CONFIG_ADDRESS }] },
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

beforeEach(() => {
  resetConfigCatalogCachesForTests()
  mockPool = 'present'
  mockConfig = CONFIG_ADDRESS
  mockQuoteFee = 5_000_000n
  mockBaseFee = 0n
  claimCalls = []
  patch('getLatestBlockhash', async () => ({
    blockhash: '4uQeVj5tqViQh7yWWGStvkEG1RgTksVZc8k1q1iT1c1k',
    lastValidBlockHeight: 350_000_042,
  }))
  patch('simulateTransaction', async () => {
    throw new Error('simulateTransaction not available in tests')
  })
  patch('getRecentPrioritizationFees', async () => [])
})

afterEach(() => {
  while (restores.length) restores.pop()?.()
})

async function rejectsWith(body: unknown, status: number, error?: string): Promise<void> {
  await assert.rejects(prepareClaimTx(body, null, makeDeps()), (err: unknown) => {
    assert.ok(err instanceof ClaimError)
    assert.equal(err.status, status)
    if (error) assert.equal(err.fields.error, error)
    return true
  })
}

describe('prepareClaimTx', () => {
  for (const [label, body] of [
    ['not an object', null],
    ['missing poolAddress', { creatorPublicKey: CREATOR }],
    ['missing creatorPublicKey', { poolAddress: POOL_ADDRESS }],
    ['bad creatorPublicKey', { poolAddress: POOL_ADDRESS, creatorPublicKey: 'nope' }],
  ] as const) {
    it(`rejects ${label} as a 400`, () => rejectsWith(body, 400))
  }

  it('404s when there is no pool, or the account is not a pool', async () => {
    mockPool = 'missing'
    await rejectsWith({ poolAddress: POOL_ADDRESS, creatorPublicKey: CREATOR }, 404, 'pool_not_found')
    mockPool = 'not-a-pool'
    await rejectsWith({ poolAddress: POOL_ADDRESS, creatorPublicKey: CREATOR }, 404, 'pool_not_found')
  })

  it('refuses a pool whose config SeekUplift does not serve', async () => {
    mockConfig = UNSERVED_CONFIG
    await rejectsWith({ poolAddress: POOL_ADDRESS, creatorPublicKey: CREATOR }, 403, 'config_not_served')
    assert.equal(claimCalls.length, 0)
  })

  it('refuses a wallet that is not the pool creator', async () => {
    await rejectsWith({ poolAddress: POOL_ADDRESS, creatorPublicKey: OTHER_WALLET }, 403, 'not_creator')
    assert.equal(claimCalls.length, 0)
  })

  it('refuses when nothing is claimable', async () => {
    mockQuoteFee = 0n
    await rejectsWith({ poolAddress: POOL_ADDRESS, creatorPublicKey: CREATOR }, 409, 'no_claimable_fees')
  })

  it('builds the claim for the full claimable amounts, creator as payer', async () => {
    mockBaseFee = 7n
    const result = await prepareClaimTx(
      { poolAddress: POOL_ADDRESS, creatorPublicKey: CREATOR },
      null,
      makeDeps(),
    )
    assert.equal(claimCalls.length, 1)
    const args = claimCalls[0]
    assert.equal(String(args.creator), CREATOR)
    assert.equal(String(args.payer), CREATOR)
    assert.equal(String(args.pool), POOL_ADDRESS)
    assert.equal(String(args.maxQuoteAmount), '5000000')
    assert.equal(String(args.maxBaseAmount), '7')
    assert.deepEqual(result.claimable, { quoteAtoms: '5000000', baseAtoms: '7' })
    assert.equal(result.poolInfo.configKey, CONFIG_ADDRESS)
    const tx = Transaction.from(Buffer.from(result.transaction, 'base64'))
    assert.equal(tx.feePayer?.toBase58(), CREATOR)
    // IV-S-1: the expiry bound from the same getLatestBlockhash read.
    assert.equal(result.lastValidBlockHeight, 350_000_042)
    assert.equal(tx.recentBlockhash, '4uQeVj5tqViQh7yWWGStvkEG1RgTksVZc8k1q1iT1c1k')
  })
})
