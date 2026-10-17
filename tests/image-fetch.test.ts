/**
 * SSRF-guard tests for `fetchRemoteImage` — the `imageUrl` launch path.
 *
 * DNS and the socket layer are seams (`resolveHost` / `transport`), so the
 * refusal matrix — private literals, private/mixed DNS answers, redirect to
 * private, DNS rebinding — runs with no real DNS or TCP. The pinning test
 * asserts the transport is handed ONLY the vetted addresses, which is what
 * stops a second DNS answer from rebinding the connection.
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  fetchRemoteImage,
  ImageFetchError,
  isBlockedIp,
  type ImageFetchDeps,
  type PinnedHttpResponse,
  type PinnedTransport,
} from '../src/lib/image-fetch.ts'

/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PUBLIC_A = '93.184.216.34' // example.com's classic public IP
const PUBLIC_B = '93.184.216.35'

async function* bytesOf(data: Buffer | Uint8Array): AsyncIterable<Uint8Array> {
  yield new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function okResponse(body: Buffer | Uint8Array, contentType = 'image/png'): PinnedHttpResponse {
  return {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(body.length) },
    body: bytesOf(body),
  }
}

function redirect(location: string): PinnedHttpResponse {
  return { status: 302, headers: { location }, body: bytesOf(Buffer.alloc(0)) }
}

type TransportCall = { url: string; addresses: readonly string[] }

/**
 * A recording transport: `responders` maps `host` → response (or a fn of the
 * full URL). Every call records the pinned address list it was handed.
 */
function stubTransport(
  responders: Record<string, PinnedHttpResponse | ((url: URL) => PinnedHttpResponse)>,
): { transport: PinnedTransport; calls: TransportCall[] } {
  const calls: TransportCall[] = []
  const transport: PinnedTransport = async (url, pinnedAddresses) => {
    calls.push({ url: url.toString(), addresses: [...pinnedAddresses] })
    const r = responders[url.hostname]
    if (r == null) throw new Error(`stubTransport: no responder for ${url.hostname}`)
    return typeof r === 'function' ? r(url) : r
  }
  return { transport, calls }
}

function resolver(map: Record<string, string[]>): (host: string) => Promise<string[]> {
  return async (host) => {
    const a = map[host]
    if (!a) throw new Error(`NXDOMAIN (stub): ${host}`)
    return a
  }
}

async function expectRefused(
  fn: () => Promise<unknown>,
  match: RegExp | string,
  status?: number,
): Promise<ImageFetchError> {
  try {
    await fn()
  } catch (err) {
    assert.ok(err instanceof ImageFetchError, `expected ImageFetchError, got ${err}`)
    const text = `${err.message}`
    if (match instanceof RegExp) assert.match(text, match)
    else assert.ok(text.includes(match), `expected "${text}" to include "${match}"`)
    if (status != null) assert.equal(err.status, status, `expected status ${status}: ${text}`)
    return err
  }
  assert.fail('expected ImageFetchError')
}

// ─── isBlockedIp classification ───────────────────────────────────────────────

describe('isBlockedIp', () => {
  it('blocks the required IPv4 ranges', () => {
    for (const ip of [
      '127.0.0.1', '127.53.0.9', // loopback /8
      '10.0.0.1', '10.255.255.255', // RFC1918
      '172.16.0.1', '172.31.255.254', // RFC1918
      '192.168.0.1', '192.168.255.1', // RFC1918
      '169.254.169.254', // link-local / cloud metadata
      '100.64.0.1', '100.127.255.255', // CGNAT 100.64/10
      '0.0.0.0', '0.1.2.3', // unspecified / this-net
      '198.18.0.1', '224.0.0.1', '255.255.255.255', // bench / multicast / broadcast
    ]) {
      assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`)
    }
  })

  it('blocks the IPv6 equivalents', () => {
    for (const ip of [
      '::1', '::',
      'fe80::1', 'febf::ffff',
      'fc00::1', 'fdff::1',
      'fec0::1',
      'ff02::1', // multicast
      '2001:db8::1', // documentation
      '2001::1', // Teredo
      '::ffff:127.0.0.1', '::ffff:0a00:1', '::ffff:6440:1', // mapped loopback/10.x/CGNAT
      '::ffff:169.254.169.254', // mapped link-local
      '64:ff9b::7f00:1', // NAT64-embedded loopback
      '64:ff9b::a0a:101', // NAT64-embedded 10.10.1.1
      '2002:7f00:1::', // 6to4-embedded 127.0.0.1
    ]) {
      assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`)
    }
  })

  it('allows public addresses', () => {
    for (const ip of [
      '93.184.216.34', '8.8.8.8', '1.1.1.1', '104.16.0.1',
      '2606:4700:4700::1111', '2606:2800:220:1:248:1893:25c8:1946',
      '100.63.255.255', // just below CGNAT
      '100.128.0.1', // just above CGNAT
      '11.0.0.1', '172.15.0.1', '172.32.0.1', '192.167.0.1', '192.169.0.1',
    ]) {
      assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`)
    }
  })
})

// ─── URL refusal matrix ───────────────────────────────────────────────────────

describe('fetchRemoteImage — refused targets', () => {
  const neverResolve = async (host: string): Promise<string[]> => {
    assert.fail(`resolveHost must not be called for ${host}`)
  }
  const neverTransport: PinnedTransport = async (url) => {
    assert.fail(`transport must not be called for ${url}`)
  }
  const deps: ImageFetchDeps = { resolveHost: neverResolve, transport: neverTransport }

  it('refuses non-http(s) schemes', async () => {
    for (const u of [
      'ftp://example.com/x.png',
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'gopher://127.0.0.1/x',
      'ipfs://bafkreiexample/x.png', // ipfs:// is not fetched — a gateway URL is required
      'not a url',
    ]) {
      await expectRefused(() => fetchRemoteImage(u, deps), /http\(s\)|not a valid URL/, 400)
    }
  })

  it('refuses loopback, private, link-local, CGNAT and unspecified literals', async () => {
    for (const u of [
      'http://127.0.0.1/x.png',
      'http://127.1/x.png', // normalized to 127.0.0.1 by the URL parser
      'http://2130706433/x.png', // decimal 127.0.0.1
      'http://0x7f000001/x.png', // hex 127.0.0.1
      'http://10.0.0.8/x.png',
      'http://172.16.5.5/x.png',
      'http://192.168.1.20/x.png',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.10/x.png',
      'http://0.0.0.0/x.png',
      'http://[::1]/x.png',
      'http://[fe80::a]/x.png',
      'http://[fc00::a]/x.png',
      'http://[::ffff:127.0.0.1]/x.png',
      'http://[::ffff:a9fe:a9fe]/x.png', // mapped 169.254.169.254
    ]) {
      await expectRefused(() => fetchRemoteImage(u, deps), /blocked address/, 400)
    }
  })

  it('refuses internal hostnames without resolving', async () => {
    for (const u of [
      'http://localhost/x.png',
      'http://localhost./x.png',
      'http://x.localhost/x.png',
      'http://printer.local/x.png',
      'http://db.internal/x.png',
      'http://metadata.google.internal/x',
    ]) {
      await expectRefused(() => fetchRemoteImage(u, deps), /not allowed/, 400)
    }
  })

  it('refuses URLs with credentials', async () => {
    await expectRefused(
      () => fetchRemoteImage('http://user:pass@example.com/x.png', deps),
      /credentials/,
      400,
    )
  })

  it('refuses a hostname that resolves to private only', async () => {
    await expectRefused(
      () =>
        fetchRemoteImage('http://internal.example/x.png', {
          resolveHost: resolver({ 'internal.example': ['127.0.0.1'] }),
          transport: neverTransport,
        }),
      /resolves to a blocked address/,
      400,
    )
    await expectRefused(
      () =>
        fetchRemoteImage('http://internal.example/x.png', {
          resolveHost: resolver({ 'internal.example': ['192.168.1.1', '10.0.0.1'] }),
          transport: neverTransport,
        }),
      /resolves to a blocked address/,
      400,
    )
  })

  it('refuses a MIXED public+private answer — every answer is vetted', async () => {
    await expectRefused(
      () =>
        fetchRemoteImage('http://rebind.example/x.png', {
          resolveHost: resolver({ 'rebind.example': [PUBLIC_A, '169.254.169.254'] }),
          transport: neverTransport,
        }),
      /resolves to a blocked address/,
      400,
    )
    await expectRefused(
      () =>
        fetchRemoteImage('http://rebind.example/x.png', {
          resolveHost: resolver({ 'rebind.example': ['127.0.0.1', PUBLIC_A] }),
          transport: neverTransport,
        }),
      /resolves to a blocked address/,
      400,
    )
  })
})

// ─── Pinning / rebinding ──────────────────────────────────────────────────────

describe('fetchRemoteImage — connection pinning', () => {
  it('pins the connection to the vetted DNS answer (no second lookup possible)', async () => {
    const { transport, calls } = stubTransport({ 'cdn.example': okResponse(PNG) })
    const result = await fetchRemoteImage('https://cdn.example/logo.png', {
      resolveHost: resolver({ 'cdn.example': [PUBLIC_A, PUBLIC_B] }),
      transport,
    })
    assert.equal(result.contentType, 'image/png')
    assert.equal(result.bytes.equals(PNG), true)
    assert.equal(result.fileName, 'image.png')
    // The transport received exactly the vetted addresses — the socket is
    // created from this list, so a hostile second DNS answer cannot rebind it.
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].addresses, [PUBLIC_A, PUBLIC_B])
  })

  it('fails closed when DNS fails', async () => {
    await expectRefused(
      () =>
        fetchRemoteImage('https://gone.example/x.png', {
          resolveHost: resolver({}),
          transport: async () => {
            assert.fail('transport must not run when DNS fails')
          },
        }),
      /could not be resolved/,
      502,
    )
  })
})

// ─── Redirects ────────────────────────────────────────────────────────────────

describe('fetchRemoteImage — redirects', () => {
  it('follows a redirect to another public host with vet+pin per hop', async () => {
    const { transport, calls } = stubTransport({
      'a.example': redirect('https://b.example/final.png'),
      'b.example': okResponse(PNG),
    })
    const result = await fetchRemoteImage('https://a.example/start', {
      resolveHost: resolver({ 'a.example': [PUBLIC_A], 'b.example': [PUBLIC_B] }),
      transport,
    })
    assert.equal(result.contentType, 'image/png')
    assert.equal(calls.length, 2)
    // Each hop pinned to ITS OWN vetted answer.
    assert.deepEqual(calls[0].addresses, [PUBLIC_A])
    assert.deepEqual(calls[1].addresses, [PUBLIC_B])
  })

  it('refuses a redirect to a private literal', async () => {
    const { transport, calls } = stubTransport({
      'a.example': redirect('http://169.254.169.254/latest/meta-data'),
    })
    await expectRefused(
      () =>
        fetchRemoteImage('https://a.example/x.png', {
          resolveHost: resolver({ 'a.example': [PUBLIC_A] }),
          transport,
        }),
      /blocked address/,
      400,
    )
    assert.equal(calls.length, 1, 'the private target is never fetched')
  })

  it('refuses a redirect to a host resolving private', async () => {
    const { transport } = stubTransport({
      'a.example': redirect('https://b.example/x.png'),
    })
    await expectRefused(
      () =>
        fetchRemoteImage('https://a.example/x.png', {
          resolveHost: resolver({ 'a.example': [PUBLIC_A], 'b.example': ['127.0.0.1'] }),
          transport,
        }),
      /resolves to a blocked address/,
      400,
    )
  })

  it('refuses a redirect to a non-http(s) target', async () => {
    const { transport } = stubTransport({
      'a.example': redirect('file:///etc/passwd'),
    })
    await expectRefused(
      () =>
        fetchRemoteImage('https://a.example/x.png', {
          resolveHost: resolver({ 'a.example': [PUBLIC_A] }),
          transport,
        }),
      /http\(s\)/,
      400,
    )
  })

  it('bounds the redirect hop count', async () => {
    const { transport, calls } = stubTransport({
      'loop.example': (url) => redirect(`${url.toString()}?n=1`),
    })
    await expectRefused(
      () =>
        fetchRemoteImage('https://loop.example/x', {
          resolveHost: resolver({ 'loop.example': [PUBLIC_A] }),
          transport,
          maxRedirects: 3,
        }),
      /redirects/,
      502,
    )
    assert.ok(calls.length <= 4)
  })
})

// ─── Response sanity ──────────────────────────────────────────────────────────

describe('fetchRemoteImage — response sanity', () => {
  const depsFor = (resp: PinnedHttpResponse | ((url: URL) => PinnedHttpResponse)) => ({
    resolveHost: resolver({ 'cdn.example': [PUBLIC_A] }),
    transport: stubTransport({ 'cdn.example': resp }).transport,
  })

  it('refuses non-2xx statuses', async () => {
    await expectRefused(
      () => fetchRemoteImage('https://cdn.example/x.png', depsFor({ status: 404, headers: {}, body: bytesOf(PNG) })),
      /HTTP 404/,
      502,
    )
    await expectRefused(
      () => fetchRemoteImage('https://cdn.example/x.png', depsFor({ status: 500, headers: {}, body: bytesOf(PNG) })),
      /HTTP 500/,
      502,
    )
  })

  it('refuses a non-image Content-Type', async () => {
    await expectRefused(
      () => fetchRemoteImage('https://cdn.example/x', depsFor(okResponse(PNG, 'text/html'))),
      /not an image/,
      502,
    )
  })

  it('refuses bytes that are not a supported image even with an image/* type', async () => {
    const body = Buffer.from('<html><body>not an image</body></html>')
    await expectRefused(
      () => fetchRemoteImage('https://cdn.example/x', depsFor(okResponse(body, 'image/png'))),
      /not a supported image/,
      502,
    )
  })

  it('enforces the size cap via Content-Length before reading', async () => {
    const big = { status: 200, headers: { 'content-length': String(11 * 1024 * 1024) }, body: bytesOf(PNG) }
    await expectRefused(
      () => fetchRemoteImage('https://cdn.example/big.png', depsFor(big)),
      /10MB|upload limit/,
      400,
    )
  })

  it('enforces the size cap while streaming an oversized body', async () => {
    async function* bigBody(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < 12; i++) yield new Uint8Array(1024 * 1024)
    }
    const resp: PinnedHttpResponse = {
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: bigBody(),
    }
    await expectRefused(
      () => fetchRemoteImage('https://cdn.example/big.png', depsFor(resp)),
      /10MB|upload limit/,
      400,
    )
  })

  it('accepts a JPEG served as application/octet-stream (sniff decides)', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)])
    const result = await fetchRemoteImage(
      'https://cdn.example/x',
      depsFor(okResponse(jpeg, 'application/octet-stream')),
    )
    assert.equal(result.contentType, 'image/jpeg')
    assert.equal(result.fileName, 'image.jpg')
  })

  it('times out the whole operation', async () => {
    const slow: PinnedTransport = (_url, _addrs, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    await expectRefused(
      () =>
        fetchRemoteImage('https://cdn.example/slow.png', {
          resolveHost: resolver({ 'cdn.example': [PUBLIC_A] }),
          transport: slow,
          timeoutMs: 25,
        }),
      /timed out/,
      502,
    )
  })
})
