/**
 * TB-S-3 builder-endpoint access control — `src/lib/agent-auth.ts`:
 *
 *   - permissionless: no key passes, limited per caller network (IPv6 /64,
 *     IPv4 full address, `::ffff:` normalized — backend TB-B-8 semantics) → 429;
 *   - partner keys `AGENT_API_KEYS=<id>:<secret>,…` checked in constant time
 *     pass unlimited; a presented but unknown key → 401;
 *   - every route under `src/app/api/` wires the guard (source pin — the
 *     route handlers cannot be imported under `node --test` because
 *     `next/server` is not extension-resolvable there);
 *   - the backend transport rule: remote `BACKEND_URL` must be https, http
 *     only for the colocated loopback (assertBackendTransport).
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  checkAgentAccess,
  parseAgentApiKeys,
  rateLimitNetworkSubject,
  resolveAgentKeyId,
  type RateLimitStore,
} from '../src/lib/agent-auth.ts'
import { assertBackendTransport } from '../src/lib/config.ts'

const hdrs = (entries: Record<string, string>) =>
  ({ get: (k: string) => entries[k] ?? null }) as Pick<Headers, 'get'>

const KEYS = 'alice:s3cret-one,bob:s3cret-two'

describe('parseAgentApiKeys', () => {
  it('parses the comma-separated <id>:<secret> list', () => {
    const keys = parseAgentApiKeys(KEYS)
    assert.equal(keys.length, 2)
    assert.deepEqual(keys.map((k) => k.id), ['alice', 'bob'])
  })
  it('skips malformed entries (no/empty id or secret) and tolerates whitespace', () => {
    const keys = parseAgentApiKeys(' alice:s , nosep, :noid, empty:, ,bob:two')
    assert.deepEqual(keys.map((k) => k.id), ['alice', 'bob'])
  })
  it('an id may itself contain colons only before the secret separator', () => {
    const keys = parseAgentApiKeys('a:b:c')
    assert.deepEqual(keys.map((k) => k.id), ['a'])
  })
  it('empty/unset parses to the empty list (auth disabled)', () => {
    assert.equal(parseAgentApiKeys(undefined).length, 0)
    assert.equal(parseAgentApiKeys('').length, 0)
    assert.equal(parseAgentApiKeys(' , ').length, 0)
  })
})

describe('resolveAgentKeyId — constant-time lookup', () => {
  const keys = parseAgentApiKeys(KEYS)
  it('resolves a valid <id>:<secret>', () => {
    assert.equal(resolveAgentKeyId('alice:s3cret-one', keys), 'alice')
    assert.equal(resolveAgentKeyId('bob:s3cret-two', keys), 'bob')
  })
  it('rejects a wrong secret, an unknown id, and a partial credential', () => {
    assert.equal(resolveAgentKeyId('alice:wrong', keys), null)
    assert.equal(resolveAgentKeyId('mallory:s3cret-one', keys), null)
    assert.equal(resolveAgentKeyId('alice', keys), null)
    assert.equal(resolveAgentKeyId('s3cret-one', keys), null)
    assert.equal(resolveAgentKeyId('', keys), null)
    assert.equal(resolveAgentKeyId(null, keys), null)
  })
})

describe('checkAgentAccess — permissionless access with partner keys', () => {
  const tight = { perNetwork: { limit: 3, windowMs: 60_000 } }
  const opts = (store: RateLimitStore, now = 10_000) => ({ agentApiKeys: KEYS, store, limits: tight, now })

  it('no key passes as an anonymous caller', () => {
    assert.deepEqual(checkAgentAccess(hdrs({}), '203.0.113.7', opts(new Map())), { ok: true, keyId: null })
  })

  it('anonymous callers are limited per network, and other networks are unaffected', () => {
    const store: RateLimitStore = new Map()
    for (let i = 0; i < 3; i++) assert.equal(checkAgentAccess(hdrs({}), '1.1.1.1', opts(store)).ok, true)
    const res = checkAgentAccess(hdrs({}), '1.1.1.1', opts(store))
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.status, 429)
      assert.equal(res.body.error, 'rate_limited')
      assert.equal(res.body.subject, 'network')
      assert.ok((res.body.retryAfter as number) > 0)
      assert.equal(res.headers['retry-after'], String(res.body.retryAfter))
    }
    assert.equal(checkAgentAccess(hdrs({}), '1.1.1.2', opts(store)).ok, true)
  })

  it('a valid partner key passes unlimited, even from a network over its limit', () => {
    const store: RateLimitStore = new Map()
    for (let i = 0; i < 3; i++) checkAgentAccess(hdrs({}), '9.9.9.9', opts(store))
    const partner = hdrs({ 'x-api-key': 'alice:s3cret-one' })
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(checkAgentAccess(partner, '9.9.9.9', opts(store)), { ok: true, keyId: 'alice' })
    }
  })

  it('401s an unknown key (no silent downgrade to anonymous)', () => {
    for (const presented of ['alice:nope', 'mallory:s3cret-one', 'garbage']) {
      const res = checkAgentAccess(hdrs({ 'x-api-key': presented }), '203.0.113.7', opts(new Map()))
      assert.equal(res.ok, false, presented)
      if (!res.ok) assert.deepEqual([res.status, res.body.error], [401, 'unauthorized'])
    }
  })

  it('bad-key bursts cost the network bucket (429, not endless 401s)', () => {
    const store: RateLimitStore = new Map()
    const bad = hdrs({ 'x-api-key': 'alice:guess' })
    for (let i = 0; i < 3; i++) {
      const res = checkAgentAccess(bad, '8.8.8.8', opts(store))
      assert.equal(!res.ok && res.status, 401)
    }
    assert.equal((checkAgentAccess(bad, '8.8.8.8', opts(store)) as { status?: number }).status, 429)
  })

  it('unset/empty AGENT_API_KEYS means no partners; keyless calls still pass', () => {
    for (const agentApiKeys of ['', null]) {
      const store: RateLimitStore = new Map()
      assert.equal(checkAgentAccess(hdrs({}), '203.0.113.7', { agentApiKeys, store }).ok, true)
      const res = checkAgentAccess(hdrs({ 'x-api-key': 'alice:s3cret-one' }), '203.0.113.7', { agentApiKeys, store })
      assert.equal(!res.ok && res.status, 401)
    }
  })

  it('the window slides: old hits stop counting', () => {
    const store: RateLimitStore = new Map()
    for (let i = 0; i < 3; i++) checkAgentAccess(hdrs({}), '1.1.1.1', opts(store, 0))
    assert.equal(checkAgentAccess(hdrs({}), '1.1.1.1', opts(store, 61_000)).ok, true)
  })
})

describe('rateLimitNetworkSubject — TB-B-8 network keying', () => {
  it('IPv6 callers share one bucket per /64', () => {
    const a = rateLimitNetworkSubject('2001:db8:abcd:1::1')
    const b = rateLimitNetworkSubject('2001:db8:abcd:1:ffff:ffff:ffff:ffff')
    assert.equal(a, b)
    assert.equal(a, 'v6:2001:db8:abcd:1::/64')
    const otherNet = rateLimitNetworkSubject('2001:db8:abcd:2::1')
    assert.notEqual(otherNet, a)
  })
  it('IPv4 keys on the full address', () => {
    assert.equal(rateLimitNetworkSubject('203.0.113.7'), 'v4:203.0.113.7')
    assert.notEqual(rateLimitNetworkSubject('203.0.113.8'), 'v4:203.0.113.7')
  })
  it('::ffff: mapped IPv6 normalizes to the IPv4 key', () => {
    assert.equal(rateLimitNetworkSubject('::ffff:203.0.113.7'), 'v4:203.0.113.7')
    assert.equal(rateLimitNetworkSubject('0:0:0:0:0:ffff:cb00:7107'), 'v4:203.0.113.7')
  })
  it('null/unresolvable IPs share the single unknown bucket', () => {
    assert.equal(rateLimitNetworkSubject(null), 'unknown')
    assert.equal(rateLimitNetworkSubject('not-an-ip'), 'unknown')
  })
})

describe('builder-route wiring (source pin)', () => {
  const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'api')
  const routeFiles: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (entry === 'route.ts') routeFiles.push(p)
    }
  }
  walk(apiDir)

  it('every src/app/api/**/route.ts runs checkAgentAccess before handling', () => {
    assert.ok(routeFiles.length >= 5, `expected builder routes under ${apiDir}`)
    for (const file of routeFiles) {
      const src = readFileSync(file, 'utf8')
      assert.match(src, /checkAgentAccess\(/, `${file} does not call checkAgentAccess`)
      assert.match(src, /from '[^']*agent-auth[^']*'/, `${file} does not import the guard`)
    }
  })
})

describe('BACKEND_URL transport rule', () => {
  it('https is accepted for any host', () => {
    assert.equal(assertBackendTransport('https://backend.example.com'), 'https://backend.example.com')
  })
  it('http is accepted only on loopback', () => {
    for (const url of [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]:3000',
      'http://127.99.0.1',
    ]) {
      assert.equal(assertBackendTransport(url), url)
    }
  })
  it('rejects remote http and non-http(s) schemes', () => {
    for (const url of [
      'http://backend.example.com',
      'http://10.0.0.5:3000',
      'http://192.168.1.5',
      'ftp://127.0.0.1',
      'not-a-url',
    ]) {
      assert.throws(() => assertBackendTransport(url), /BACKEND_URL/, url)
    }
  })
})
