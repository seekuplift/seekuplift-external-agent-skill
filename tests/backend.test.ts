/** Backend client tests — caller-IP extraction and X-Forwarded-For forwarding. */
import { strict as assert } from 'node:assert'
import { describe, it, afterEach } from 'node:test'
import { backendGetJson, clientIpFromHeaders } from '../src/lib/backend.ts'
import {
  decodeBase64Image,
  uploadImageBytes,
  uploadMetadataJson,
  uploadPartnerHeaders,
} from '../src/lib/upload.ts'

/** A 1×1 transparent PNG. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
  it('returns null on non-IP garbage and ignores x-real-ip', () => {
    assert.equal(clientIpFromHeaders(hdrs({ 'x-forwarded-for': '2001:db8::1' })), '2001:db8::1')
    assert.equal(clientIpFromHeaders(hdrs({ 'x-forwarded-for': 'not-an-ip' })), null)
    assert.equal(clientIpFromHeaders(hdrs({ 'x-forwarded-for': '1:2:3' })), null)
    assert.equal(clientIpFromHeaders(hdrs({ 'x-forwarded-for': '999.1.1.1' })), null)
    assert.equal(clientIpFromHeaders(hdrs({ 'x-real-ip': '203.0.113.7' })), null)
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

describe('upload proxy seam', () => {
  it('POSTs image bytes to /api/upload/image as multipart with XFF', async () => {
    let seen: {
      url: string
      method: string
      xff: string | null
      file: unknown
    } | null = null
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const form = init?.body instanceof FormData ? init.body : null
      seen = {
        url: String(url),
        method: init?.method ?? 'GET',
        xff: new Headers(init?.headers).get('x-forwarded-for'),
        file: form?.get('file'),
      }
      return new Response('{"cid":"bafy","url":"https://gw/bafy"}', { status: 200 })
    }) as typeof fetch

    const out = await uploadImageBytes(decodeBase64Image(PNG_1PX), '203.0.113.7')
    assert.deepEqual(out, { cid: 'bafy', url: 'https://gw/bafy' })
    assert.equal(seen!.method, 'POST')
    assert.match(seen!.url, /\/api\/upload\/image$/)
    assert.equal(seen!.xff, '203.0.113.7')
    assert.ok(seen!.file, 'multipart `file` field missing')
  })

  it('POSTs metadata JSON to /api/upload/metadata with XFF', async () => {
    let seen: {
      url: string
      method: string
      xff: string | null
      contentType: string | null
      body: unknown
    } | null = null
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        method: init?.method ?? 'GET',
        xff: new Headers(init?.headers).get('x-forwarded-for'),
        contentType: new Headers(init?.headers).get('content-type'),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      }
      return new Response('{"cid":"bafm","url":"https://gw/bafm"}', { status: 200 })
    }) as typeof fetch

    const out = await uploadMetadataJson({ name: 'X', launchType: 'meme' }, '198.51.100.4')
    assert.deepEqual(out, { cid: 'bafm', url: 'https://gw/bafm' })
    assert.equal(seen!.method, 'POST')
    assert.match(seen!.url, /\/api\/upload\/metadata$/)
    assert.equal(seen!.xff, '198.51.100.4')
    assert.equal(seen!.contentType, 'application/json')
    assert.deepEqual(seen!.body, { name: 'X', launchType: 'meme' })
  })

  it('sends the partner-lane headers only with a partner id and a configured token', () => {
    const token = 't'.repeat(32)
    assert.deepEqual(uploadPartnerHeaders('guildshot', token), {
      'x-upload-partner': 'guildshot',
      'x-upload-partner-token': token,
    })
    assert.deepEqual(uploadPartnerHeaders(null, token), {})
    assert.deepEqual(uploadPartnerHeaders('guildshot', undefined), {})
    assert.deepEqual(uploadPartnerHeaders('guildshot', '  '), {})
  })
})
