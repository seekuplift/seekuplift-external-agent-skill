/**
 * GET /api/pools tests — the catalog-config `partnerConfigs` proxy over the
 * backend's `/api/stream/list` + `/api/stream/search`. The stream payloads
 * are real captures from the production backend; the mobile-config payload
 * is the production capture shared with the catalog tests.
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { resetConfigCatalogCachesForTests } from '../src/lib/config-catalog.ts'
import { listPools, PoolsError } from '../src/lib/pools.ts'
import {
  loadFixture,
  mobileConfigFixture,
  LEGACY_CONFIG_KEY,
  LIVE_CONFIG_KEY,
} from './helpers.ts'

const realFetch = globalThis.fetch

type SeenRequest = { url: string; xff: string | null }

/** Stub fetch: records every request, serves `handler`'s body per call. */
function stubFetch(handler: (url: string) => { status?: number; body: unknown }): {
  requests: SeenRequest[]
} {
  const requests: SeenRequest[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    requests.push({
      url: href,
      xff: new Headers(init?.headers).get('x-forwarded-for'),
    })
    const served = handler(href)
    return new Response(JSON.stringify(served.body), { status: served.status ?? 200 })
  }) as typeof fetch
  return { requests }
}

beforeEach(() => resetConfigCatalogCachesForTests())
afterEach(() => {
  globalThis.fetch = realFetch
  resetConfigCatalogCachesForTests()
})

const listFixture = () => loadFixture<{ items: unknown[]; nextCursor: string | null }>('stream-list.json')
const graduatedFixture = () =>
  loadFixture<{ items: unknown[]; nextCursor: string | null }>('stream-list-graduated.json')

const catalogDeps = {
  fetchMobileConfig: async () => mobileConfigFixture(),
}

describe('GET /api/pools', () => {
  it('lists via /api/stream/list with EVERY served catalog config as partnerConfigs', async () => {
    const { requests } = stubFetch((url) => {
      assert.ok(url.includes('/api/stream/list'), `unexpected backend call: ${url}`)
      return { body: listFixture() }
    })

    const result = await listPools({}, '203.0.113.7', { catalogDeps })

    assert.equal(requests.length, 1)
    const url = new URL(requests[0].url)
    assert.equal(url.pathname, '/api/stream/list')
    // The live fixture serves the same key under all three categories —
    // deduplicated once into the CSV.
    assert.equal(url.searchParams.get('partnerConfigs'), LIVE_CONFIG_KEY)
    assert.equal(url.searchParams.get('limit'), '20')
    // The caller IP rides X-Forwarded-For into the backend's read bucket.
    assert.equal(requests[0].xff, '203.0.113.7')

    // Every captured item is on the live config and keeps the consumer fields.
    assert.equal(result.pools.length, listFixture().items.length)
    for (const pool of result.pools) {
      assert.equal(pool.configKey, LIVE_CONFIG_KEY)
      assert.ok(pool.id, 'pool address missing')
      assert.ok(pool.baseMint, 'baseMint missing')
      assert.equal(typeof pool.name, 'string')
      assert.equal(typeof pool.symbol, 'string')
      assert.equal(typeof pool.price, 'number')
      assert.equal(typeof pool.marketCap, 'number')
      assert.equal(typeof pool.graduated, 'boolean')
    }
    assert.ok(result.pools.some((p) => p.volume24h != null))
    // The real capture's keyset cursor passes through for pagination.
    assert.equal(result.nextCursor, listFixture().nextCursor)
  })

  it('composes partnerConfigs from EVERY catalog config key across categories', async () => {
    let partnerConfigs: string | null = null
    stubFetch((url) => {
      partnerConfigs = new URL(url).searchParams.get('partnerConfigs')
      return { body: { items: [], nextCursor: null } }
    })
    const multiConfig = {
      fetchMobileConfig: async () =>
        mobileConfigFixture({
          launchConfigOptions: {
            meme: [
              { configKey: LIVE_CONFIG_KEY, optionId: 'default' },
              { configKey: LEGACY_CONFIG_KEY, optionId: 'legacy' },
            ],
            idea: [{ configKey: LEGACY_CONFIG_KEY, optionId: 'legacy' }],
            startup: [{ configKey: LIVE_CONFIG_KEY, optionId: 'default' }],
          },
          version: 'v-multi-pools',
        }),
    }
    await listPools({}, null, { catalogDeps: multiConfig })
    assert.equal(partnerConfigs, `${LIVE_CONFIG_KEY},${LEGACY_CONFIG_KEY}`)
  })

  it('keeps the legacy ?search= param: /api/stream/search with q + all configs', async () => {
    const { requests } = stubFetch((url) => {
      assert.ok(url.includes('/api/stream/search'), `unexpected backend call: ${url}`)
      return { body: graduatedFixture().items }
    })
    const result = await listPools({ search: 'SKRG', limit: '5' }, '198.51.100.4', {
      catalogDeps,
    })
    assert.equal(requests.length, 1)
    const url = new URL(requests[0].url)
    assert.equal(url.pathname, '/api/stream/search')
    assert.equal(url.searchParams.get('q'), 'SKRG')
    assert.equal(url.searchParams.get('partnerConfigs'), LIVE_CONFIG_KEY)
    assert.equal(url.searchParams.get('limit'), '5')
    assert.equal(requests[0].xff, '198.51.100.4')
    assert.equal(result.nextCursor, null)
    // Graduated coins are marked.
    const skrg = result.pools.find((p) => p.symbol === 'SKRG')
    assert.ok(skrg)
    assert.equal(skrg.graduated, true)
    assert.equal(typeof skrg.graduatedAt, 'number')
    assert.equal(skrg.bondingCurve, 1)
    assert.equal(skrg.quoteSymbol, 'SKR')
  })

  it('forwards the list controls (cursor, tab, category, lifecycle, sortBy)', async () => {
    const { requests } = stubFetch(() => ({ body: listFixture() }))
    await listPools(
      {
        cursor: 'opaque-cursor',
        tab: 'graduated',
        category: 'idea',
        lifecycle: 'new',
        sortBy: 'marketCap',
        limit: '7',
      },
      null,
      { catalogDeps },
    )
    const params = new URL(requests[0].url).searchParams
    assert.equal(params.get('cursor'), 'opaque-cursor')
    assert.equal(params.get('tab'), 'graduated')
    assert.equal(params.get('category'), 'idea')
    assert.equal(params.get('lifecycle'), 'new')
    assert.equal(params.get('sortBy'), 'marketCap')
    assert.equal(params.get('limit'), '7')
  })

  it('rejects bad enum params and non-numeric limits before any stream call', async () => {
    const { requests } = stubFetch(() => ({ body: {} }))
    for (const [query, pattern] of [
      [{ tab: 'hot' }, /tab must be one of/],
      [{ category: 'stock' }, /category must be one of/],
      [{ lifecycle: 'old' }, /lifecycle must be one of/],
      [{ sortBy: 'holders' }, /sortBy must be one of/],
      [{ limit: 'abc' }, /limit must be a number/],
    ] as const) {
      await assert.rejects(() => listPools(query, null, { catalogDeps }), PoolsError)
      await assert.rejects(() => listPools(query, null, { catalogDeps }), pattern)
    }
    assert.equal(requests.length, 0)
  })

  it('clamps limit into the backend range (1..100)', async () => {
    const { requests } = stubFetch(() => ({ body: { items: [], nextCursor: null } }))
    await listPools({ limit: '500' }, null, { catalogDeps })
    assert.equal(new URL(requests[0].url).searchParams.get('limit'), '100')
    await listPools({ limit: '0' }, null, { catalogDeps })
    assert.equal(new URL(requests[1].url).searchParams.get('limit'), '1')
  })

  it('returns an empty list — never the backend env fallback — when the catalog serves no keys', async () => {
    const { requests } = stubFetch(() => ({ body: listFixture() }))
    const emptyCatalog = {
      fetchMobileConfig: async () =>
        mobileConfigFixture({
          launchConfigOptions: { meme: [], idea: [], startup: [] },
          launchConfigKeys: {},
          version: 'v-empty-pools',
        }),
    }
    const result = await listPools({ search: 'SKR' }, null, { catalogDeps: emptyCatalog })
    assert.deepEqual(result, { pools: [], nextCursor: null })
    // No stream call: an empty partnerConfigs would make the backend fall
    // back to its env configs, which are not the catalog.
    assert.equal(requests.length, 0)
  })

  it('drops pools whose configKey is not a served catalog key', async () => {
    const fixture = listFixture()
    const foreign = {
      ...(fixture.items[0] as Record<string, unknown>),
      configKey: LEGACY_CONFIG_KEY, // real key, but NOT in the served catalog
    }
    stubFetch(() => ({ body: { items: [...fixture.items, foreign], nextCursor: null } }))
    const result = await listPools({}, null, { catalogDeps })
    assert.equal(result.pools.length, fixture.items.length)
    assert.ok(result.pools.every((p) => p.configKey === LIVE_CONFIG_KEY))
  })

  it('keeps retired configs listed in LISTED_CONFIG_KEYS', async () => {
    const fixture = listFixture()
    const retired = { ...(fixture.items[0] as Record<string, unknown>), configKey: LEGACY_CONFIG_KEY }
    let partnerConfigs: string | null = null
    stubFetch((url) => {
      partnerConfigs = new URL(url).searchParams.get('partnerConfigs')
      return { body: { items: [...fixture.items, retired], nextCursor: null } }
    })
    process.env.LISTED_CONFIG_KEYS = LEGACY_CONFIG_KEY
    try {
      const result = await listPools({}, null, { catalogDeps })
      assert.equal(result.pools.length, fixture.items.length + 1)
      assert.equal(partnerConfigs, `${LIVE_CONFIG_KEY},${LEGACY_CONFIG_KEY}`)
    } finally {
      delete process.env.LISTED_CONFIG_KEYS
    }
  })

  it('marks graduated coins on the list path too', async () => {
    stubFetch(() => ({ body: graduatedFixture() }))
    const result = await listPools({ tab: 'graduated' }, null, { catalogDeps })
    assert.ok(result.pools.length > 0)
    for (const pool of result.pools) {
      assert.equal(pool.graduated, true)
      assert.equal(pool.bondingCurve, 1)
    }
  })
})
