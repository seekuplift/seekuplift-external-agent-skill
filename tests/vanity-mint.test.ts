/**
 * VM-4 — backend vanity mint fetch + validation (fetch stubbed, no network).
 * Secrets here are throwaway test keypairs; none is ever printed.
 */
import { strict as assert } from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { Keypair } from '@solana/web3.js'
import { fetchVanityMint, parseVanityMintResponse } from '../src/lib/vanity-mint.ts'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = []
  for (const b of bytes) {
    let carry = b
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (const b of bytes) {
    if (b !== 0) break
    out += '1'
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]]
  return out
}

/** Grind a keypair ending in "up" (~1/3400 per try). */
function grindUp(): Keypair {
  for (;;) {
    const kp = Keypair.generate()
    if (kp.publicKey.toBase58().endsWith('up')) return kp
  }
}

const vanity = grindUp()
const body = (kp: Keypair, pub = kp.publicKey.toBase58()) => ({
  publicKey: pub,
  secretKey: encodeBase58(kp.secretKey),
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('parseVanityMintResponse', () => {
  it('accepts a well-formed vanity keypair', () => {
    assert.equal(parseVanityMintResponse(body(vanity)).publicKey.toBase58(), vanity.publicKey.toBase58())
  })
  it('rejects a pubkey that does not match the secret', () => {
    const other = grindUp()
    assert.throws(() => parseVanityMintResponse(body(vanity, other.publicKey.toBase58())), /mismatch/)
  })
  it('rejects an address that does not end in "up"', () => {
    let plain = Keypair.generate()
    while (plain.publicKey.toBase58().endsWith('up')) plain = Keypair.generate()
    assert.throws(() => parseVanityMintResponse(body(plain)), /does not end in up/)
  })
  it('rejects a wrong-length secret and bad shapes', () => {
    assert.throws(
      () => parseVanityMintResponse({ publicKey: vanity.publicKey.toBase58(), secretKey: encodeBase58(vanity.secretKey.slice(0, 32)) }),
      /64 bytes/,
    )
    assert.throws(() => parseVanityMintResponse({ publicKey: 1, secretKey: 2 }), /bad shape/)
    assert.throws(() => parseVanityMintResponse(null), /bad shape/)
    assert.throws(() => parseVanityMintResponse({ publicKey: 'x', secretKey: '0OIl' }), /encoding/)
  })
})

describe('fetchVanityMint', () => {
  it('POSTs an empty JSON body with the caller IP as X-Forwarded-For and returns the keypair', async () => {
    let seen: { url: string; method?: string; xff: string | null; body?: unknown } | null = null
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        method: init?.method,
        xff: new Headers(init?.headers).get('x-forwarded-for'),
        body: init?.body,
      }
      return new Response(JSON.stringify(body(vanity)), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const kp = await fetchVanityMint('203.0.113.5')
    assert.equal(kp.publicKey.toBase58(), vanity.publicKey.toBase58())
    assert.ok(seen!.url.endsWith('/api/launch/mint-keypair'))
    assert.equal(seen!.method, 'POST')
    assert.equal(seen!.xff, '203.0.113.5')
    assert.equal(seen!.body, '{}')
  })
  it('throws on 429 and 503 so the builder falls back', async () => {
    for (const status of [429, 503]) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'x' }), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
      await assert.rejects(fetchVanityMint(null))
    }
  })
})
