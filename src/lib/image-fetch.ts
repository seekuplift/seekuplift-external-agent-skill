/**
 * SSRF-safe remote image fetcher — backs the `imageUrl` launch field.
 *
 * This service runs colocated with backend-rs-sql on the production hosts, so
 * an agent-controlled URL is a server-side request forgery primitive against
 * loopback/private services (the backend itself, cloud metadata, …). The
 * guard mirrors `security.rs`'s `metadata_url_vet` + `build_pinned_metadata_client`:
 *
 *   1. http(s) only; credentials in the URL refused; known internal
 *      hostnames (`localhost`, `*.localhost`, `*.local`, `*.internal`,
 *      `metadata.google.internal`) refused.
 *   2. IP literals are vetted directly. Hostnames are resolved via DNS and
 *      EVERY resolved address is vetted — a mixed public+private answer is
 *      refused outright, not raced.
 *   3. The connection is PINNED to the vetted addresses through a custom
 *      `lookup` callback while the original hostname keeps driving the Host
 *      header and TLS SNI/certificate verification — a second DNS answer can
 *      never rebind the connection (the DNS-rebinding TOCTOU).
 *   4. Redirects are followed MANUALLY (vet + pin per hop, bounded hop
 *      count, http(s) targets only) — an http→private redirect is refused.
 *   5. Size capped at the backend's `MAX_IMAGE_BYTES` (10 MB), short overall
 *      timeout, Content-Type sanity, and the same magic-byte sniff the
 *      backend applies (`sniff_image_mime`).
 *
 * Tests inject `resolveHost`/`transport` to cover private answers, mixed
 * answers, redirect-to-private and the pin itself without real DNS/TCP.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import type { LookupAddress } from 'node:dns'
import {
  MAX_UPLOAD_IMAGE_BYTES,
  MIME_EXTENSION,
  sniffImageMime,
  type DecodedLaunchImage,
} from './upload.ts'

/** Whole-operation deadline (all redirect hops + body read). */
export const IMAGE_FETCH_TIMEOUT_MS = 10_000
/** Bound on manually-followed redirect hops. */
export const IMAGE_FETCH_MAX_REDIRECTS = 3
/** Size cap = the backend's image upload limit. */
export const IMAGE_FETCH_MAX_BYTES = MAX_UPLOAD_IMAGE_BYTES

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** A refusal/failure from the fetcher. `status` maps onto HTTP semantics. */
export class ImageFetchError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ImageFetchError'
    this.status = status
  }
}

// ─── IP classification ───────────────────────────────────────────────────────

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) return NaN
    return Number(p)
  })
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null
}

/**
 * Parse an IPv6 literal into 16 bytes. Handles `::` compression, embedded
 * dotted-quad tails (`::ffff:1.2.3.4`) and zone ids. Returns null on garbage.
 */
function ipv6ToBytes(input: string): number[] | null {
  let s = input.toLowerCase()
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  // Expand an embedded dotted-quad tail into two hex segments first.
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':')
    if (idx === -1) return null
    const v4 = ipv4ToBytes(s.slice(idx + 1))
    if (!v4) return null
    s = `${s.slice(0, idx)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parseSeg = (seg: string): number | null =>
    /^[0-9a-f]{1,4}$/.test(seg) ? parseInt(seg, 16) : null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  if (head.length + tail.length > 8) return null
  const segments: number[] = []
  for (const seg of head) {
    const v = parseSeg(seg)
    if (v == null) return null
    segments.push(v)
  }
  while (segments.length + tail.length < 8) segments.push(0)
  for (const seg of tail) {
    const v = parseSeg(seg)
    if (v == null) return null
    segments.push(v)
  }
  if (segments.length !== 8) return null
  const bytes: number[] = []
  for (const seg of segments) bytes.push(seg >> 8, seg & 0xff)
  return bytes
}

function isBlockedV4(b: number[]): boolean {
  const [a, x, c] = b
  return (
    a === 0 || // 0.0.0.0/8 — unspecified / "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && x >= 64 && x <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && x === 254) || // link-local (cloud metadata)
    (a === 172 && x >= 16 && x <= 31) || // RFC1918
    (a === 192 && x === 0) || // 192.0.0.0/24 + 192.0.2.0/24 (doc)
    (a === 192 && x === 88 && c === 99) || // 6to4 relay anycast 192.88.99.0/24
    (a === 192 && x === 168) || // RFC1918
    (a === 198 && (x === 18 || x === 19)) || // benchmarking 198.18.0.0/15
    (a === 198 && x === 51 && c === 100) || // doc 198.51.100.0/24
    (a === 203 && x === 0 && c === 113) || // doc 203.0.113.0/24
    a >= 224 // multicast 224/4 + reserved 240/4 + broadcast
  )
}

function isBlockedV6(b: number[]): boolean {
  // IPv4-mapped ::ffff:a.b.c.d (and ::ffff:0:x) — vet the embedded v4 so
  // `::ffff:127.0.0.1` cannot bypass the v4 loopback checks.
  const prefix10 = b.slice(0, 10).every((x) => x === 0)
  if (prefix10 && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4(b.slice(12, 16))
  }
  // IPv4-compatible ::a.b.c.d (::/96) — same embedded-v4 vetting; this also
  // covers :: (unspecified → 0.0.0.0) and ::1 (loopback → 0.0.0.1).
  if (prefix10 && b[10] === 0 && b[11] === 0) {
    return isBlockedV4(b.slice(12, 16))
  }
  // NAT64 well-known prefix 64:ff9b::/96 — embedded v4 in the last 4 bytes.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return isBlockedV4(b.slice(12, 16))
  }
  // 6to4 2002::/16 — embedded v4 in bytes 2–5.
  if (b[0] === 0x20 && b[1] === 0x02) {
    return isBlockedV4(b.slice(2, 6))
  }
  return (
    b[0] === 0xff || // multicast ff00::/8
    (b[0] & 0xfe) === 0xfc || // unique-local fc00::/7
    (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || // link-local fe80::/10
    (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) || // site-local fec0::/10 (deprecated)
    (b[0] === 0x01 && b.slice(1, 8).every((x) => x === 0)) || // discard-only 100::/64
    (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) || // doc 2001:db8::/32
    (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) // Teredo 2001::/32
  )
}

/**
 * True when `ip` is loopback, private, link-local, CGNAT, unspecified,
 * multicast, documentation or otherwise unsuitable as a fetch target —
 * including IPv6 equivalents and embedded-v4 forms (::ffff:…, NAT64, 6to4).
 * Exported for tests.
 */
export function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const b = ipv4ToBytes(ip)
    return b == null || isBlockedV4(b)
  }
  if (isIP(ip) === 6) {
    const b = ipv6ToBytes(ip)
    return b == null || isBlockedV6(b)
  }
  return true
}

// ─── URL vetting ─────────────────────────────────────────────────────────────

function stripV6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Parse + scheme/userinfo/host check. Throws `ImageFetchError` (400). */
function parseImageUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ImageFetchError('imageUrl is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageFetchError(`imageUrl must be http(s) — got "${url.protocol.slice(0, -1) || 'unknown'}"`)
  }
  if (url.username || url.password) {
    throw new ImageFetchError('imageUrl must not contain credentials')
  }
  return url
}

export type ResolveHost = (hostname: string) => Promise<string[]>

const defaultResolveHost: ResolveHost = async (hostname) => {
  const addrs = await dnsLookup(hostname, { all: true, verbatim: true })
  return addrs.map((a) => a.address)
}

/**
 * Vet `url` and return the addresses the connection may be pinned to.
 * Resolves DNS, refuses when ANY answer is a blocked address (a mixed
 * answer is refused rather than raced — the whole answer set is vetted).
 */
async function vetImageUrl(url: URL, resolveHost: ResolveHost): Promise<string[]> {
  const host = stripV6Brackets(url.hostname).toLowerCase().replace(/\.+$/, '')
  if (!host) {
    throw new ImageFetchError('imageUrl has no host')
  }
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new ImageFetchError(`imageUrl host "${host}" is not allowed`)
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new ImageFetchError(`imageUrl targets a blocked address: ${host}`)
    }
    return [host]
  }
  let addresses: string[]
  try {
    addresses = await resolveHost(host)
  } catch {
    throw new ImageFetchError(`imageUrl host "${host}" could not be resolved`, 502)
  }
  if (!addresses.length) {
    throw new ImageFetchError(`imageUrl host "${host}" resolved to no addresses`, 502)
  }
  const blocked = addresses.filter((a) => !isIP(a) || isBlockedIp(a))
  if (blocked.length > 0) {
    throw new ImageFetchError(
      `imageUrl host "${host}" resolves to a blocked address: ${blocked[0]}`,
    )
  }
  return addresses
}

// ─── Pinned transport ────────────────────────────────────────────────────────

export type PinnedHttpResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
}

/**
 * One request to `url` whose connection MUST be pinned to (a member of)
 * `pinnedAddresses` — the vetted DNS answer — while `url`'s hostname keeps
 * driving the Host header and TLS SNI/certificate verification.
 */
export type PinnedTransport = (
  url: URL,
  pinnedAddresses: readonly string[],
  signal: AbortSignal,
) => Promise<PinnedHttpResponse>

/**
 * Production transport: `http(s).request` with a `lookup` callback that
 * serves ONLY the vetted addresses — Node's resolver is bypassed entirely,
 * so no second DNS answer can rebind the socket. The URL object keeps the
 * real hostname for the Host header; `servername` keeps TLS SNI/verification
 * on the original hostname.
 */
const defaultTransport: PinnedTransport = (url, pinnedAddresses, signal) =>
  new Promise<PinnedHttpResponse>((resolve, reject) => {
    const isTls = url.protocol === 'https:'
    const pinned: LookupAddress[] = pinnedAddresses.map((address) => ({
      address,
      family: isIP(address) || 4,
    }))
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) {
        callback(null, pinned)
      } else {
        callback(null, pinned[0].address, pinned[0].family)
      }
    }
    const req = (isTls ? httpsRequest : httpRequest)(
      url,
      {
        lookup,
        // Keep SNI on the real hostname (skipped for IP-literal hosts, where
        // TLS ignores it anyway).
        servername: isTls && !isIP(stripV6Brackets(url.hostname))
          ? stripV6Brackets(url.hostname)
          : undefined,
        headers: {
          accept: 'image/*,*/*;q=0.8',
          'user-agent': 'seekuplift-agent-skill/1.0 (+image fetch)',
        },
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: res,
        })
      },
    )
    const onAbort = () => req.destroy(new Error('image fetch timed out'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', reject)
    req.on('close', () => signal.removeEventListener('abort', onAbort))
    req.end()
  })

// ─── Body + content sanity ───────────────────────────────────────────────────

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name]
  return Array.isArray(v) ? v[0] : v
}

function destroyBody(body: AsyncIterable<Uint8Array>): void {
  const d = (body as { destroy?: () => void }).destroy
  if (typeof d === 'function') d.call(body)
}

async function readCapped(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.length
    if (total > maxBytes) {
      destroyBody(body)
      throw new ImageFetchError(
        `image exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB upload limit`,
      )
    }
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }
  return Buffer.concat(chunks)
}

/**
 * Content-Type sanity: `image/*` and the generic binary types may proceed to
 * the magic-byte sniff; anything else (text/html, application/json, …) is
 * refused without reading the body.
 */
function isAcceptableContentType(contentType: string): boolean {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return (
    mime.startsWith('image/') ||
    mime === 'application/octet-stream' ||
    mime === 'binary/octet-stream'
  )
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Race a promise against the operation deadline (covers the DNS vet, which
 *  otherwise is bounded only by OS resolver timeouts). */
function abortable<T>(p: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new ImageFetchError(`imageUrl fetch timed out after ${timeoutMs}ms`, 502))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export type ImageFetchDeps = {
  /** DNS seam — production default is `dns.promises.lookup`. */
  resolveHost?: ResolveHost
  /** HTTP seam — production default pins the socket via `lookup`. */
  transport?: PinnedTransport
  timeoutMs?: number
  maxRedirects?: number
  maxBytes?: number
}

/**
 * Fetch a public image URL through the SSRF guard: vet (scheme, hostname,
 * every resolved address), pin the connection to the vetted addresses, and
 * follow redirects manually with vet+pin per hop. Returns bytes + the
 * sniffed image type ready for `uploadImageBytes`.
 */
export async function fetchRemoteImage(
  rawUrl: string,
  deps: ImageFetchDeps = {},
): Promise<DecodedLaunchImage> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new ImageFetchError('imageUrl must be a non-empty string')
  }
  const resolveHost = deps.resolveHost ?? defaultResolveHost
  const transport = deps.transport ?? defaultTransport
  const timeoutMs = deps.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS
  const maxRedirects = deps.maxRedirects ?? IMAGE_FETCH_MAX_REDIRECTS
  const maxBytes = deps.maxBytes ?? IMAGE_FETCH_MAX_BYTES

  const signal = AbortSignal.timeout(timeoutMs)
  let url = parseImageUrl(rawUrl.trim())

  for (let hop = 0; ; hop++) {
    // Vet + resolve EVERY hop — the redirect target gets the full guard.
    const addresses = await abortable(vetImageUrl(url, resolveHost), signal, timeoutMs)

    let res: PinnedHttpResponse
    try {
      res = await transport(url, addresses, signal)
    } catch (err) {
      if (signal.aborted) {
        throw new ImageFetchError(`imageUrl fetch timed out after ${timeoutMs}ms`, 502)
      }
      throw new ImageFetchError(
        `imageUrl fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      )
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = firstHeader(res.headers, 'location')
      destroyBody(res.body)
      if (!location) {
        throw new ImageFetchError(`imageUrl redirect (HTTP ${res.status}) has no Location`, 502)
      }
      if (hop >= maxRedirects) {
        throw new ImageFetchError(`imageUrl exceeded ${maxRedirects} redirects`, 502)
      }
      // Relative Location resolves against the current URL; the scheme /
      // host checks below vet the absolute result.
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new ImageFetchError('imageUrl redirect Location is not a valid URL', 502)
      }
      url = parseImageUrl(next.toString())
      continue
    }

    if (res.status < 200 || res.status >= 300) {
      destroyBody(res.body)
      throw new ImageFetchError(`imageUrl fetch failed: HTTP ${res.status}`, 502)
    }

    const contentTypeHeader = firstHeader(res.headers, 'content-type')
    if (contentTypeHeader && !isAcceptableContentType(contentTypeHeader)) {
      destroyBody(res.body)
      throw new ImageFetchError(
        `imageUrl returned "${contentTypeHeader.split(';')[0].trim()}", not an image`,
        502,
      )
    }
    const declaredLength = Number.parseInt(firstHeader(res.headers, 'content-length') ?? '', 10)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      destroyBody(res.body)
      throw new ImageFetchError(
        `image exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB upload limit`,
      )
    }

    let bytes: Buffer
    try {
      bytes = await readCapped(res.body, maxBytes)
    } catch (err) {
      if (err instanceof ImageFetchError) throw err
      if (signal.aborted) {
        throw new ImageFetchError(`imageUrl fetch timed out after ${timeoutMs}ms`, 502)
      }
      throw new ImageFetchError(
        `imageUrl body read failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      )
    }
    if (bytes.length === 0) {
      throw new ImageFetchError('imageUrl returned an empty body', 502)
    }

    // The backend's own gate: magic-byte sniff, never the declared type.
    const sniffed = sniffImageMime(bytes)
    if (!sniffed) {
      throw new ImageFetchError(
        'imageUrl bytes are not a supported image. Allowed: PNG, JPEG, GIF, WEBP',
        502,
      )
    }
    return { bytes, contentType: sniffed, fileName: `image.${MIME_EXTENSION[sniffed]}` }
  }
}
