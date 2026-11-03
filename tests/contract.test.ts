/**
 * DD-S-1 contract tests — the public contract (1.0.0) exercised against
 * recorded backend fixtures.
 *
 *   - launch: configKey/category are required; the first buy rides
 *     firstBuyAtoms/firstBuyAmount. Runs the REAL `buildLaunchTx` behind a
 *     stubbed DBC client/connection, so the quote mint and the atomic amount
 *     are asserted in the constructed transaction's parameters — not only in
 *     the response body.
 *   - quote: the response carries the documented fields.
 *   - pools: the `?search`/`?limit` surface and the list params over the
 *     recorded `/api/stream/*` captures.
 *
 * Backend reads ride the recorded fixtures (production `/api/mobile-config`
 * + `/api/stream/list` + real on-chain getAccountInfo decodes through the
 * SDK); upload/build seams are stubs or the real builder over fakes.
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  getConfigCatalogWithGeo,
  resetConfigCatalogCachesForTests,
  type CatalogDeps,
  type MobileConfigResponse,
} from '../src/lib/config-catalog.ts'
import { NATIVE_MINT } from '../src/lib/config.ts'
import { prepareLaunch, LaunchError, type LaunchDeps } from '../src/lib/launch.ts'
import { listPools } from '../src/lib/pools.ts'
import { prepareTradeQuote, type TradeDeps } from '../src/lib/trade.ts'
import {
  decodePoolConfigFixture,
  loadFixture,
  mobileConfigFixture,
  poolsFixtureMobileConfig,
  POOLS_FIXTURE_CONFIG_KEY,
  DONATION_CLAIM_AUTHORITY,
  TEST_WALLET,
  LEGACY_CONFIG_ACCOUNT,
  LEGACY_CONFIG_KEY,
  LIVE_CONFIG_ACCOUNT,
  LIVE_CONFIG_KEY,
} from './helpers.ts'

const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const PAYER = TEST_WALLET // any valid on-curve base58 key

/** A 1×1 transparent PNG. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

beforeEach(() => resetConfigCatalogCachesForTests())
afterEach(() => resetConfigCatalogCachesForTests())

// ─── Fixture-backed catalog seams (same recipe as launch.test.ts) ─────────────

async function catalogDeps(
  extraPoolConfigs: Record<string, (decoded: Record<string, unknown>) => Record<string, unknown>> = {},
  mobileConfig: Partial<MobileConfigResponse> = {},
): Promise<CatalogDeps> {
  const live = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
  const legacy = await decodePoolConfigFixture(LEGACY_CONFIG_ACCOUNT)
  const base: Record<string, Record<string, unknown> | null> = {
    [LIVE_CONFIG_KEY]: live,
    [LEGACY_CONFIG_KEY]: legacy,
  }
  for (const [key, patch] of Object.entries(extraPoolConfigs)) {
    base[key] = patch(base[key] ?? live!)
  }
  return {
    fetchMobileConfig: async () => mobileConfigFixture(mobileConfig),
    fetchPoolConfig: async (key) => base[key] ?? null,
    // The quote mint is always read on-chain — answer per mint (wSOL is 9).
    fetchMintInfo: async (mint) => ({
      decimals: mint === NATIVE_MINT ? 9 : 6,
      tokenProgram: SPL_TOKEN_PROGRAM,
      scaledUiAmount: null,
    }),
    donationClaimAuthorities: [DONATION_CLAIM_AUTHORITY],
  }
}

// ─── The REAL tx builder over a fake client/connection ───────────────────────
// Captures what the constructed transaction is actually built from:
// createPoolParam.config (the config key), the getTokenBadge lookup (the
// quote mint) and firstBuyParam.buyAmount (the atomic amount).

type Captured = {
  badgeLookups: string[]
  createPoolParam: Record<string, unknown> | null
  firstBuyParam: Record<string, unknown> | null
  firstBuyQuoteArgs: Record<string, unknown> | null
}

function realBuildDeps(captured: Captured): NonNullable<LaunchDeps['buildTxDeps']> {
  const txWithMintSigner = (baseMint: PublicKey): Transaction =>
    new Transaction().add({
      programId: new PublicKey('11111111111111111111111111111111'),
      keys: [{ pubkey: baseMint, isSigner: true, isWritable: true }],
      data: Buffer.alloc(0),
    })
  const client = {
    state: {
      getTokenBadge: async (mint: PublicKey) => {
        captured.badgeLookups.push(mint.toBase58())
        return null
      },
      // DD-S-2: the first-buy path reads the config for the simulated
      // opening-curve quote — serve a minimal slot-based, first-buy-enabled
      // config; the quote itself is stubbed on `pool` below.
      getPoolConfig: async () => ({ activationType: 0, enableFirstSwapWithMinFee: 1 }),
    },
    pool: {
      getQuoteFromInputAmount: (args: Record<string, unknown>) => {
        captured.firstBuyQuoteArgs = args
        return { outputAmount: { toString: () => '2000000' } }
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
  const connection = {
    // getCurrentPoint reads the slot for the (slot-based) quoted config.
    getSlot: async () => 1,
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1,
    }),
    simulateTransaction: async () => ({
      context: { slot: 1 },
      value: { err: null, unitsConsumed: 70_000, logs: [] },
    }),
    getRecentPrioritizationFees: async () => [],
  } as unknown as Connection
  return { client, connection }
}

type CallLog = { imageUploads: number; metadataUploads: number }

function launchDeps(
  catDeps: CatalogDeps,
  log: CallLog,
  captured: Captured,
  extra: LaunchDeps = {},
): LaunchDeps {
  return {
    loadCatalog: (ip) => getConfigCatalogWithGeo(ip, catDeps),
    fetchCauses: async () => [], // no causes offered → meme needs no donation pick
    fetchCauseModes: async () => ({ modes: [], fallbackMode: 'managed' }),
    fetchIdeaModes: async () => ({ modes: [], takeoverMode: 'realms', milestonesEnabled: false }),
    uploadImage: async () => {
      log.imageUploads += 1
      return { cid: 'bafyimage', url: 'https://ipfs.filebase.io/ipfs/bafyimage' }
    },
    uploadMetadata: async () => {
      log.metadataUploads += 1
      return { cid: 'bafymeta', url: 'https://ipfs.filebase.io/ipfs/bafymeta' }
    },
    // The REAL buildLaunchTx on the fake SDK client + connection.
    buildTxDeps: realBuildDeps(captured),
    ...extra,
  }
}

function launchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configKey: LIVE_CONFIG_KEY,
    category: 'meme',
    name: 'Test Coin',
    symbol: 'tst',
    description: 'launched by a contract test',
    image: PNG_1PX,
    payerPublicKey: PAYER,
    ...overrides,
  }
}

function newCaptured(): Captured {
  return { badgeLookups: [], createPoolParam: null, firstBuyParam: null, firstBuyQuoteArgs: null }
}

async function expectLaunchError(
  fn: () => Promise<unknown>,
  status: number,
): Promise<LaunchError> {
  try {
    await fn()
  } catch (err) {
    assert.ok(err instanceof LaunchError, `expected LaunchError, got ${err}`)
    assert.equal(err.status, status, `expected ${status}, got ${err.status} (${err.message})`)
    return err
  }
  assert.fail('expected LaunchError')
}

// ─── Launch ───────────────────────────────────────────────────────────────────

describe('contract — launch (configKey + category required, firstBuyAtoms | firstBuyAmount)', () => {
  it('requires configKey and category, before any upload', async () => {
    for (const missing of ['configKey', 'category']) {
      const log: CallLog = { imageUploads: 0, metadataUploads: 0 }
      const captured = newCaptured()
      const deps = launchDeps(await catalogDeps(), log, captured)
      const body = launchBody()
      delete body[missing]
      const err = await expectLaunchError(() => prepareLaunch(body, '203.0.113.10', deps), 400)
      assert.match(err.message, new RegExp(`Missing required field: ${missing}`))
      assert.equal(log.imageUploads, 0)
      assert.equal(captured.createPoolParam, null)
    }
  })

  it('builds the tx on the chosen config with the quote-atom first buy', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0 }
    const captured = newCaptured()
    const deps = launchDeps(await catalogDeps(), log, captured)
    const result = await prepareLaunch(launchBody({ firstBuyAtoms: '100000000' }), '203.0.113.10', deps)
    assert.equal(result.configKey, LIVE_CONFIG_KEY)
    assert.equal(result.quoteMint, SKR_MINT)
    assert.equal(result.quoteSymbol, 'SKR')
    assert.equal(result.quoteDecimals, 6)
    assert.equal(result.firstBuyAtoms, '100000000')
    assert.equal((captured.createPoolParam!.config as PublicKey).toBase58(), LIVE_CONFIG_KEY)
    assert.deepEqual(captured.badgeLookups, [SKR_MINT])
    assert.equal((captured.firstBuyParam!.buyAmount as { toString(): string }).toString(), '100000000')
    // DD-S-2: the first buy carries a real output floor — the stubbed quote's
    // 2_000_000 output at the default 50 bps → floor 1_990_000, not the old 1.
    assert.equal(captured.firstBuyQuoteArgs!.slippageBps, 50)
    assert.equal(
      (captured.firstBuyParam!.minimumAmountOut as { toString(): string }).toString(),
      '1990000',
    )
  })

  it('treats firstBuyAmount: "0.0" as no first buy', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0 }
    const captured = newCaptured()
    const deps = launchDeps(await catalogDeps(), log, captured)
    const result = await prepareLaunch(launchBody({ firstBuyAmount: '0.0' }), null, deps)
    assert.equal(result.firstBuyAtoms, null)
    assert.equal(captured.firstBuyParam, null)
    assert.equal(log.imageUploads, 1)
  })

  it('converts firstBuyAmount to lamport atoms on a wrapped-SOL-quoted config', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0 }
    const captured = newCaptured()
    // Serve the legacy key as a meme option, decoded as wSOL-quoted with the
    // first-buy flag on (the live decode patched at the field level).
    const fixture = mobileConfigFixture()
    const catDeps = await catalogDeps(
      {
        // The legacy decode patched to a wSOL quote AND the first-buy flag
        // on (the legacy config has enableFirstSwapWithMinFee unset).
        [LEGACY_CONFIG_KEY]: (decoded) => ({
          ...decoded,
          quoteMint: NATIVE_MINT,
          enableFirstSwapWithMinFee: 1,
        }),
      },
      {
        launchConfigOptions: {
          ...(fixture.launchConfigOptions as object),
          meme: [
            { configKey: LEGACY_CONFIG_KEY, optionId: 'sol', quoteMint: NATIVE_MINT },
          ],
        },
      },
    )
    const deps = launchDeps(catDeps, log, captured)
    const result = await prepareLaunch(
      launchBody({ configKey: LEGACY_CONFIG_KEY, firstBuyAmount: 0.5 }),
      null,
      deps,
    )
    // 0.5 SOL × 1e9 = 500,000,000 lamport atoms — in the BUILT transaction.
    assert.equal(result.quoteMint, NATIVE_MINT)
    assert.equal(result.firstBuyAtoms, '500000000')
    assert.deepEqual(captured.badgeLookups, [NATIVE_MINT])
    assert.ok(captured.firstBuyParam)
    assert.equal((captured.firstBuyParam!.buyAmount as { toString(): string }).toString(), '500000000')
  })
})

// ─── Quote ───────────────────────────────
// The pool reads ride a stub SDK client whose getPoolConfig is the REAL
// decoded production config fixture; geo/catalog ride the recorded
// /api/mobile-config capture.

const POOL_ADDRESS = '9uFg8xPfLVVn92qeiNoBSURZdtSYYsByfp7id1WFVj3b'
const BASE_MINT = 'EYhMhoZEMnr9EJUYAAU8TX4NNEaM12yNHW2xPUgyuZMc'

const restores: Array<() => void> = []
function patchConnection(key: string, fn: unknown): void {
  const proto = Connection.prototype as unknown as Record<string, unknown>
  const original = proto[key]
  proto[key] = fn
  restores.push(() => {
    proto[key] = original
  })
}

afterEach(() => {
  while (restores.length) restores.pop()?.()
})

async function tradeDeps(): Promise<TradeDeps> {
  const decoded = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
  patchConnection('getSlot', async () => 1)
  patchConnection('getParsedAccountInfo', async () => ({
    value: { data: { parsed: { info: { decimals: 6 } } } },
  }))
  patchConnection('getAccountInfo', async () => null)
  return {
    connection: new Connection('http://127.0.0.1:1'),
    client: {
      state: {
        getPool: async () => ({
          baseMint: new PublicKey(BASE_MINT),
          config: new PublicKey(LIVE_CONFIG_KEY),
          quoteReserve: { toString: () => '0' },
          isMigrated: 0,
          migrationProgress: 0,
        }),
        getPoolConfig: async () => decoded,
      },
      pool: {
        swapQuote2: (args: Record<string, unknown>) => {
          return {
            outputAmount: { toString: () => '900000' },
            minimumAmountOut: { toString: () => '855000' },
            includedFeeInputAmount: (args.amountIn as { toString(): string }),
            amountLeft: { toString: () => '0' },
          }
        },
        swapQuote: () => {
          throw new Error('sell path unused in this test')
        },
      },
    } as unknown as DynamicBondingCurveClient,
    catalogDeps: { fetchMobileConfig: async () => mobileConfigFixture() },
    fetchPoolMetadata: async () => ({ launchType: 'meme' }),
  }
}

describe('contract — trade quote over the recorded backend fixture', () => {
  it('returns the documented quote fields', async () => {
    const result = await prepareTradeQuote(
      { poolAddress: POOL_ADDRESS, side: 'buy', amountIn: '2000000', slippageBps: 50 },
      '203.0.113.7',
      await tradeDeps(),
    )
    assert.equal(result.amountOut, '900000')
    assert.equal(result.minimumAmountOut, '855000')
    assert.ok(result.poolInfo)
    assert.equal(result.poolInfo.quoteMint, SKR_MINT) // the decoded production config
    assert.equal(result.poolInfo.isQuoteSol, false)
    assert.equal(result.poolInfo.isCompleted, false)
    assert.equal(result.consumedInput, '2000000')
    assert.equal(result.amountLeft, '0')
    assert.equal(result.poolInfo.migrationState, 'curve')
    assert.equal(result.poolInfo.configKey, LIVE_CONFIG_KEY)
    assert.equal(typeof result.poolInfo.quoteDecimals, 'number')
  })
})

// ─── Pools: search and list params over the recorded stream capture ──────────

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubBackendFetch(handler: (url: string) => { status?: number; body: unknown }) {
  const requests: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url)
    requests.push(href)
    const served = handler(href)
    return new Response(JSON.stringify(served.body), { status: served.status ?? 200 })
  }) as typeof fetch
  return requests
}

const poolsCatalogDeps = { fetchMobileConfig: async () => poolsFixtureMobileConfig() }
const streamItems = () =>
  loadFixture<{ items: unknown[]; nextCursor: string | null }>('stream-list.json')

describe('contract — pools over the recorded stream capture', () => {
  it('?search + ?limit hit /api/stream/search and return pool records', async () => {
    const requests = stubBackendFetch((url) => {
      assert.ok(url.includes('/api/stream/search'), `unexpected call: ${url}`)
      return { body: streamItems().items }
    })
    const result = await listPools({ search: 'QA', limit: '5' }, '203.0.113.7', {
      catalogDeps: poolsCatalogDeps,
    })
    const url = new URL(requests[0])
    assert.equal(url.searchParams.get('q'), 'QA')
    assert.equal(url.searchParams.get('limit'), '5')
    // Every captured pool is on the prod-indexed config.
    assert.ok(result.pools.length > 0)
    for (const pool of result.pools) {
      assert.equal(pool.configKey, POOLS_FIXTURE_CONFIG_KEY)
      assert.ok(pool.id && pool.name && 'price' in pool && 'marketCap' in pool)
    }
    assert.equal(result.nextCursor, null) // no cursor on search
  })

  it('list params (tab/category/lifecycle/sortBy/cursor) reach /api/stream/list', async () => {
    const requests = stubBackendFetch((url) => {
      assert.ok(url.includes('/api/stream/list'), `unexpected call: ${url}`)
      return { body: streamItems() }
    })
    const result = await listPools(
      { tab: 'graduated', category: 'idea', lifecycle: 'new', sortBy: 'marketCap', cursor: 'abc' },
      '203.0.113.7',
      { catalogDeps: poolsCatalogDeps },
    )
    const params = new URL(requests[0]).searchParams
    assert.equal(params.get('tab'), 'graduated')
    assert.equal(params.get('category'), 'idea')
    assert.equal(params.get('lifecycle'), 'new')
    assert.equal(params.get('sortBy'), 'marketCap')
    assert.equal(params.get('cursor'), 'abc')
    assert.ok(params.get('partnerConfigs')!.split(',').includes(POOLS_FIXTURE_CONFIG_KEY))
    assert.ok(Array.isArray(result.pools))
  })
})
