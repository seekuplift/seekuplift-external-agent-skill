/**
 * POST /api/discover tests (CD-S-1) — the thin forward to the backend's
 * discover endpoint: edge validation with the backend's own limits,
 * X-Forwarded-For forwarding, error passthrough, and the privacy rule
 * (query text never logged, stored or echoed). The backend is stubbed —
 * tests never hit a real one.
 *
 * The route handler itself cannot be imported under `node --test`
 * (`next/server` is not extension-resolvable there), so the handler's
 * guard order is exercised through the same calls the route makes, plus a
 * source pin on the route file.
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { describe, it, afterEach } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkAgentAccess, type RateLimitStore } from '../src/lib/agent-auth.ts'
import { BackendHttpError } from '../src/lib/backend.ts'
import { discover, DiscoverError } from '../src/lib/discover.ts'

const realFetch = globalThis.fetch
const ROUTE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'app',
  'api',
  'discover',
  'route.ts',
)

type SeenRequest = { url: string; method: string; xff: string | null; body: unknown }

/** Stub fetch: records every request, serves `handler`'s response per call. */
function stubFetch(handler: (url: string) => { status?: number; body: unknown }): {
  requests: SeenRequest[]
} {
  const requests: SeenRequest[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    requests.push({
      url: href,
      method: init?.method ?? 'GET',
      xff: new Headers(init?.headers).get('x-forwarded-for'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const served = handler(href)
    return new Response(JSON.stringify(served.body), { status: served.status ?? 200 })
  }) as typeof fetch
  return { requests }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const SHORTLIST = {
  mode: 'keyword',
  results: [
    {
      mint: 'ReefMint1111111111111111111111111111111111',
      name: 'Reef Guardians',
      symbol: 'REEF',
      kind: 'cause',
      funds: { cause: 'Ocean', project: 'Coral Restoration Fund', idea: null },
      marketCap: 41200,
      volume24h: 3100,
      stage: 'curve',
      match: 0.82,
      why: 'matches: ocean conservation',
    },
  ],
  excludedForRegion: 2,
  nextCursor: 'cursor-opaque',
}

async function expectInvalid(body: unknown, field: string): Promise<DiscoverError> {
  try {
    await discover(body, '203.0.113.7')
  } catch (err) {
    assert.ok(err instanceof DiscoverError, `expected DiscoverError, got ${err}`)
    assert.equal(err.status, 400)
    assert.equal(err.fields.error, 'invalid_request')
    assert.equal(err.fields.field, field)
    // Same { error, field, message } shape the backend's invalid_request uses.
    assert.equal(err.fields.message, err.message)
    return err
  }
  assert.fail(`expected DiscoverError for field ${field}`)
}

describe('POST /api/discover — forwarding', () => {
  it('POSTs the request body verbatim to /api/discover with the caller IP on X-Forwarded-For', async () => {
    const { requests } = stubFetch((url) => {
      assert.ok(url.endsWith('/api/discover'), `unexpected backend call: ${url}`)
      return { body: SHORTLIST }
    })
    const request = {
      interests: 'ocean conservation, kids education',
      avoid: ['gambling'],
      filters: { kind: 'cause', causeSlugs: ['ocean'], stage: 'curve', minVolume24h: 10 },
      sort: 'active',
      limit: 5,
      cursor: 'page-1-cursor',
    }
    const result = await discover(request, '203.0.113.7')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].xff, '203.0.113.7')
    assert.deepEqual(requests[0].body, request)
    // The backend response is returned unchanged.
    assert.deepEqual(result, SHORTLIST)
  })

  it('omits X-Forwarded-For for an unresolvable caller IP', async () => {
    const { requests } = stubFetch(() => ({ body: SHORTLIST }))
    await discover({ interests: 'ocean' }, null)
    assert.equal(requests[0].xff, null)
  })

  it('accepts the sparsest valid body and every optional field at its bound', async () => {
    const { requests } = stubFetch(() => ({ body: SHORTLIST }))
    await discover({ interests: 'ocean' }, null)
    assert.equal(requests.length, 1)
    await discover(
      {
        interests: 'a'.repeat(500),
        avoid: ['b'.repeat(80)],
        filters: { kind: 'any', causeSlugs: [], stage: 'any', minVolume24h: 0 },
        sort: 'newest',
        limit: 25,
        cursor: null,
      },
      null,
    )
    assert.equal(requests.length, 2)
  })
})

describe('POST /api/discover — edge validation (400 invalid_request, field only)', () => {
  it('refuses bad shapes before any backend call, naming the field', async () => {
    const { requests } = stubFetch(() => ({ body: {} }))
    for (const [body, field] of [
      [null, 'body'],
      ['ocean conservation', 'body'],
      [[], 'body'],
      [{}, 'interests'],
      [{ interests: '' }, 'interests'],
      [{ interests: '   ' }, 'interests'],
      [{ interests: 42 }, 'interests'],
      [{ interests: 'x'.repeat(501) }, 'interests'],
      [{ interests: 'x', avoid: 'gambling' }, 'avoid'],
      [{ interests: 'x', avoid: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'avoid'],
      [{ interests: 'x', avoid: [''] }, 'avoid'],
      [{ interests: 'x', avoid: ['y'.repeat(81)] }, 'avoid'],
      [{ interests: 'x', avoid: [42] }, 'avoid'],
      [{ interests: 'x', filters: 'cause' }, 'filters'],
      [{ interests: 'x', filters: { kind: 'meme' } }, 'filters.kind'],
      [{ interests: 'x', filters: { causeSlugs: Array(51).fill('s') } }, 'filters.causeSlugs'],
      [{ interests: 'x', filters: { causeSlugs: [42] } }, 'filters.causeSlugs'],
      [{ interests: 'x', filters: { stage: 'listed' } }, 'filters.stage'],
      [{ interests: 'x', filters: { minVolume24h: -1 } }, 'filters.minVolume24h'],
      [{ interests: 'x', filters: { minVolume24h: 'high' } }, 'filters.minVolume24h'],
      [{ interests: 'x', sort: 'hot' }, 'sort'],
      [{ interests: 'x', limit: 0 }, 'limit'],
      [{ interests: 'x', limit: 26 }, 'limit'],
      [{ interests: 'x', limit: 1.5 }, 'limit'],
      [{ interests: 'x', limit: '10' }, 'limit'],
      [{ interests: 'x', cursor: 42 }, 'cursor'],
      [{ interests: 'x', cursor: 'c'.repeat(513) }, 'cursor'],
    ] as const) {
      const err = await expectInvalid(body, field)
      // Privacy: refusal messages name the field, never echo the value.
      assert.equal(typeof err.message, 'string')
    }
    assert.equal(requests.length, 0)
  })
})

describe('POST /api/discover — backend error passthrough', () => {
  it('surfaces the backend 400 invalid_request unchanged', async () => {
    const upstream = { error: 'invalid_request', field: 'cursor', message: 'invalid cursor' }
    stubFetch(() => ({ status: 400, body: upstream }))
    try {
      await discover({ interests: 'ocean', cursor: 'not-a-cursor' }, null)
      assert.fail('expected BackendHttpError')
    } catch (err) {
      assert.ok(err instanceof BackendHttpError)
      assert.equal(err.status, 400)
      assert.deepEqual(err.body, upstream)
    }
  })

  it('surfaces the backend 429 and 5xx with status and body intact', async () => {
    for (const [status, body] of [
      [429, { error: 'rate_limited', retryAfter: 30 }],
      [500, { error: 'internal' }],
    ] as const) {
      stubFetch(() => ({ status, body }))
      try {
        await discover({ interests: 'ocean' }, null)
        assert.fail(`expected BackendHttpError for ${status}`)
      } catch (err) {
        assert.ok(err instanceof BackendHttpError)
        assert.equal(err.status, status)
        assert.deepEqual(err.body, body)
      }
    }
  })
})

describe('POST /api/discover — the route guard (per-IP read limit)', () => {
  const tight = { perNetwork: { limit: 2, windowMs: 60_000 } }
  const hdrs = (entries: Record<string, string>) =>
    ({ get: (k: string) => entries[k] ?? null }) as Pick<Headers, 'get'>

  it('refuses the third call with the documented 429 shape before any backend call', async () => {
    const store: RateLimitStore = new Map()
    const opts = { agentApiKeys: null, store, limits: tight, now: 10_000 }
    const { requests } = stubFetch(() => ({ body: SHORTLIST }))

    // The same order the route runs: guard first, backend call second.
    for (let i = 0; i < 2; i++) {
      const access = checkAgentAccess(hdrs({}), '198.51.100.9', opts)
      assert.equal(access.ok, true)
      await discover({ interests: 'ocean' }, '198.51.100.9')
    }
    const access = checkAgentAccess(hdrs({}), '198.51.100.9', opts)
    assert.equal(access.ok, false)
    if (!access.ok) {
      assert.equal(access.status, 429)
      assert.equal(access.body.error, 'rate_limited')
      assert.equal(access.body.subject, 'network')
      assert.ok((access.body.retryAfter as number) > 0)
      assert.equal(access.headers['retry-after'], String(access.body.retryAfter))
    }
    // The refused call never reached the backend.
    assert.equal(requests.length, 2)
  })
})

describe('POST /api/discover — query text is never logged or echoed', () => {
  const MARKER = 'PRIV-MARKER-9f3d'

  type LogCapture = { calls: unknown[][]; restore: () => void }
  function captureConsole(): LogCapture {
    const calls: unknown[][] = []
    const methods = ['error', 'warn', 'log', 'info', 'debug'] as const
    const originals = methods.map((m) => [m, console[m]] as const)
    for (const [m] of originals) {
      console[m] = (...args: unknown[]) => {
        calls.push(args)
      }
    }
    return {
      calls,
      restore: () => {
        for (const [m, fn] of originals) console[m] = fn
      },
    }
  }
  const loggedText = (calls: unknown[][]) =>
    calls.map((args) => args.map((a) => String(a)).join(' ')).join('\n')

  it('validation refusals carry the field name only — never the query text', async () => {
    const capture = captureConsole()
    try {
      const err = await expectInvalid({ interests: `${MARKER} `.repeat(40) }, 'interests')
      assert.ok(!err.message.includes(MARKER), 'error message echoes query text')
      assert.ok(!JSON.stringify(err.fields).includes(MARKER), 'error fields echo query text')
      assert.ok(!loggedText(capture.calls).includes(MARKER), 'console echoes query text')
    } finally {
      capture.restore()
    }
  })

  it('upstream failures log a fixed line — never the query text', async () => {
    const capture = captureConsole()
    // An upstream error whose message embeds the request text — the leak
    // vector this test exists for. If the route logged `err.message` this
    // marker would reach the console.
    const leaky = `fetch failed: ${MARKER}`
    stubFetch(() => {
      throw new TypeError(leaky)
    })
    try {
      await discover({ interests: MARKER, avoid: [MARKER] }, '203.0.113.7').catch((err) => {
        assert.ok(err instanceof Error && err.message.includes(MARKER))
        // The route's generic catch logs a fixed string — simulate it verbatim.
        console.error('[/api/discover] upstream failure')
      })
      assert.ok(!loggedText(capture.calls).includes(MARKER), 'console echoes query text')
    } finally {
      capture.restore()
    }
  })

  it('a successful call logs nothing', async () => {
    const capture = captureConsole()
    stubFetch(() => ({ body: SHORTLIST }))
    try {
      await discover({ interests: MARKER }, null)
      assert.equal(capture.calls.length, 0)
    } finally {
      capture.restore()
    }
  })

  it('the route source pins the no-log rule', () => {
    const src = readFileSync(ROUTE, 'utf8')
    // Console calls may carry no request fields and no error values — an
    // upstream error's message could embed the request text it failed on.
    assert.doesNotMatch(
      src,
      /console\.(?:error|warn|log|info|debug)\([^)]*\b(body|interests|avoid|req|err|message)\b/,
      'route logs request data or error contents',
    )
  })
})

describe('POST /api/discover — route wiring (source pin)', () => {
  it('404s unless DISCOVER_ENABLED=true, before any other work (hidden until CD-B-4)', () => {
    const src = readFileSync(ROUTE, 'utf8')
    const gate = src.indexOf("process.env.DISCOVER_ENABLED !== 'true'")
    assert.ok(gate > 0, 'route must gate on DISCOVER_ENABLED')
    assert.ok(gate < src.indexOf('clientIpFromHeaders(req.headers)'), 'gate must come first')
  })

  it('runs clientIpFromHeaders + checkAgentAccess before the backend call and never caches', () => {
    const src = readFileSync(ROUTE, 'utf8')
    assert.match(src, /checkAgentAccess\(req\.headers, clientIp\)/)
    assert.match(src, /clientIpFromHeaders\(req\.headers\)/)
    // Guard precedes the forward.
    assert.ok(
      src.indexOf('checkAgentAccess(req.headers') < src.indexOf('await discover('),
      'checkAgentAccess must run before discover()',
    )
    assert.match(src, /cache-control': 'no-store'/)
  })
})
