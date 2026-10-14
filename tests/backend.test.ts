/** Backend client tests — caller-IP extraction and X-Forwarded-For forwarding. */
import { strict as assert } from 'node:assert'
import { describe, it, afterEach } from 'node:test'
import { backendGetJson, clientIpFromHeaders } from '../src/lib/backend.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('clientIpFromHeaders', () => {
  const hdrs = (entries: Record<string, string>) =>
    ({ get: (k: string) => entries[k] ?? null }) as Pick<Headers, 'get'>

  it('takes the FIRST x-forwarded-for hop (Caddy rewrites the chain to the client IP)', () => {
    assert.equal(clientIpFromHeaders(hdrs({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7')
  })
  it('falls back to x-real-ip and returns null on garbage', () => {
    assert.equal(clientIpFromHeaders(hdrs({ 'x-real-ip': '2001:db8::1' })), '2001:db8::1')
    assert.equal(clientIpFromHeaders(hdrs({ 'x-forwarded-for': 'not-an-ip' })), null)
    assert.equal(clientIpFromHeaders(hdrs({})), null)
  })
  it('accepts plain Records too', () => {
    assert.equal(clientIpFromHeaders({ 'x-forwarded-for': '192.0.2.9' }), '192.0.2.9')
  })
})

describe('backendGetJson', () => {
  it('forwards the caller IP as X-Forwarded-For and returns JSON', async () => {
    let seen: { url: string; xff: string | null } | null = null
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        xff: new Headers(init?.headers).get('x-forwarded-for'),
      }
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch

    const out = await backendGetJson<{ ok: boolean }>(
      '/api/mobile-config',
      { cluster: 'mainnet-beta', platform: 'web' },
      { clientIp: '203.0.113.7' },
    )
    assert.deepEqual(out, { ok: true })
    assert.equal(seen!.xff, '203.0.113.7')
    assert.match(seen!.url, /cluster=mainnet-beta/)
    assert.match(seen!.url, /platform=web/)
  })

  it('omits X-Forwarded-For when no caller IP resolved', async () => {
    let xff: string | null = 'sentinel'
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      xff = new Headers(init?.headers).get('x-forwarded-for')
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await backendGetJson('/api/x', {}, { clientIp: null })
    assert.equal(xff, null)
  })

  it('throws on non-2xx', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch
    await assert.rejects(() => backendGetJson('/api/x', {}, {}), /503/)
  })
})
