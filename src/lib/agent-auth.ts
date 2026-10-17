/**
 * Builder-endpoint access control (TB-S-3).
 *
 * Every `/api/*` builder route calls {@link checkAgentAccess} first. Two
 * mechanisms, both documented in DEPLOY.md and the v2 contract documents:
 *
 *   - **API keys** — a static env-held list `AGENT_API_KEYS=<id>:<secret>,…`.
 *     The caller sends the whole `id:secret` pair as `X-Api-Key`; it is
 *     checked in constant time (SHA-256 digests, `timingSafeEqual`, full
 *     scan). Missing or unknown key → 401. Keys are distributed out of band
 *     and revoked by redeploy; the service is stateless — there is no key
 *     store or issuance flow. Unset/empty `AGENT_API_KEYS` disables auth
 *     (with a startup-warning log): the in-process limits below still apply.
 *   - **Rate limits** — sliding-window, in-process (per `next start`
 *     instance — a two-host deployment roughly doubles the allowance), keyed
 *     per API key AND per caller network (TB-B-8 semantics: IPv6 callers
 *     share one bucket per /64, IPv4 per full address, `::ffff:` mapped
 *     forms normalize to the v4 key). Over the limit → 429.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

/** The header carrying the caller's `<id>:<secret>` pair. */
export const AGENT_API_KEY_HEADER = 'x-api-key'

/** Service-level limits (per `next start` instance — documented in DEPLOY.md). */
export const AGENT_RATE_LIMITS = {
  /** Per API key. Builder calls each cost several RPC reads, so this is a
   *  burst allowance, not a throughput budget. */
  perKey: { limit: 60, windowMs: 60_000 },
  /** Per caller network (IPv6 /64; IPv4 full address). More generous than
   *  per-key — a site /64 can host several keyed agents. */
  perNetwork: { limit: 240, windowMs: 60_000 },
} as const

/** Sweep idle subjects once the table grows past this many keys. */
const RATE_LIMIT_GC_THRESHOLD = 10_000
/** A timestamp older than this is expired under every window above. */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000

// ─── Key list ───────────────────────────────────────────────────────────────

type AgentKey = { id: string; digest: Buffer }

const digest = (credential: string): Buffer =>
  createHash('sha256').update(credential).digest()

/**
 * Parse the `AGENT_API_KEYS` env value into `{ id, digest }` entries.
 * Malformed entries (no `:` separator, empty side) are skipped — they can
 * never authenticate a caller.
 */
export function parseAgentApiKeys(raw: string | undefined | null): AgentKey[] {
  const keys: AgentKey[] = []
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim()
    const sep = trimmed.indexOf(':')
    if (sep <= 0 || sep === trimmed.length - 1) continue
    keys.push({ id: trimmed.slice(0, sep), digest: digest(trimmed) })
  }
  return keys
}

/**
 * Constant-time check of a presented `<id>:<secret>` against the key list:
 * the presented credential is hashed once and compared against EVERY stored
 * digest — no early exit on a matched `id`, so the check's timing does not
 * reveal which id (if any) is valid.
 */
export function resolveAgentKeyId(
  presented: string | null,
  keys: readonly AgentKey[],
): string | null {
  if (!presented || keys.length === 0) return null
  const presentedDigest = digest(presented)
  let matched: AgentKey | null = null
  for (const key of keys) {
    if (timingSafeEqual(presentedDigest, key.digest)) matched = key
  }
  return matched?.id ?? null
}

// ─── Network bucket (TB-B-8 semantics) ──────────────────────────────────────

/** Expand a validated IPv6 literal to its 8 hextets, or null. */
function ipv6Hextets(ip: string): number[] | null {
  let addr = ip.toLowerCase()
  // Dotted-quad tail (`::ffff:1.2.3.4`): rewrite to two hextets first.
  if (addr.includes('.')) {
    const idx = addr.lastIndexOf(':')
    const v4 = addr.slice(idx + 1)
    if (isIP(v4) !== 4) return null
    const octets = v4.split('.').map(Number)
    addr = `${addr.slice(0, idx)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (parts.length !== 8) return null
  const hextets = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : -1))
  return hextets.every((h) => h >= 0 && h <= 0xffff) ? hextets : null
}

/**
 * The rate-limit subject for a caller IP — mirrors the backend's
 * `rate_limit_network_subject` (TB-B-8): IPv4 keys on the full address;
 * IPv6 callers share one bucket per /64 (an end site rotates through 2^64
 * addresses, so full-address keying would be decorative); `::ffff:` mapped
 * addresses normalize to the IPv4 key. An absent/unresolvable caller IP
 * shares the single `unknown` bucket — never a fail-open per request.
 */
export function rateLimitNetworkSubject(clientIp: string | null): string {
  if (!clientIp) return 'unknown'
  const kind = isIP(clientIp)
  if (kind === 4) return `v4:${clientIp}`
  if (kind === 6) {
    const hextets = ipv6Hextets(clientIp)
    if (!hextets) return 'unknown'
    // ::ffff:a.b.c.d — first 80 bits zero + ffff — is the IPv4 caller.
    if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
      const a = (hextets[6] >> 8) & 0xff
      const b = hextets[6] & 0xff
      const c = (hextets[7] >> 8) & 0xff
      const d = hextets[7] & 0xff
      return `v4:${a}.${b}.${c}.${d}`
    }
    const net = hextets.slice(0, 4).map((h) => h.toString(16))
    return `v6:${net.join(':')}::/64`
  }
  return 'unknown'
}

// ─── Sliding-window limiter ─────────────────────────────────────────────────

export type RateLimitRule = { limit: number; windowMs: number }

/** In-process sliding-window counters, one timestamp list per subject. */
export type RateLimitStore = Map<string, number[]>

const sharedStore: RateLimitStore = new Map()

function checkWindow(
  store: RateLimitStore,
  subject: string,
  rule: RateLimitRule,
  now: number,
): { allowed: boolean; retryAfterSec: number } {
  if (store.size > RATE_LIMIT_GC_THRESHOLD) {
    for (const [key, hits] of store) {
      if (hits.length === 0 || hits[hits.length - 1] < now - MAX_WINDOW_MS) {
        store.delete(key)
      }
    }
  }
  const cutoff = now - rule.windowMs
  const hits = store.get(subject) ?? []
  while (hits.length > 0 && hits[0] <= cutoff) hits.shift()
  if (hits.length >= rule.limit) {
    return { allowed: false, retryAfterSec: Math.ceil((hits[0] + rule.windowMs - now) / 1000) }
  }
  hits.push(now)
  store.set(subject, hits)
  return { allowed: true, retryAfterSec: 0 }
}

// ─── The guard ──────────────────────────────────────────────────────────────

export type AgentAccess =
  | { ok: true; keyId: string | null }
  | {
      ok: false
      status: 401 | 429
      body: Record<string, unknown>
      /** Extra response headers (`retry-after` on 429). */
      headers: Record<string, string>
    }

export type AgentAccessOptions = {
  /** Raw `AGENT_API_KEYS` value — defaults to the env at call time. */
  agentApiKeys?: string | null
  /** Test seams — the shared in-process store and limits are the defaults. */
  store?: RateLimitStore
  limits?: { perKey: RateLimitRule; perNetwork: RateLimitRule }
  now?: number
}

let warnedAuthDisabled = false

/**
 * Check a builder request: rate limit → auth → per-key limit, in that order.
 * The network bucket is consumed for EVERY request (including rejected keys)
 * so a key-guessing flood hits the per-/64 ceiling instead of free retries.
 */
export function checkAgentAccess(
  headers: Pick<Headers, 'get'>,
  clientIp: string | null,
  options: AgentAccessOptions = {},
): AgentAccess {
  const store = options.store ?? sharedStore
  const limits = options.limits ?? AGENT_RATE_LIMITS
  const now = options.now ?? Date.now()

  const network = rateLimitNetworkSubject(clientIp)
  const net = checkWindow(store, `net:${network}`, limits.perNetwork, now)
  if (!net.allowed) {
    return {
      ok: false,
      status: 429,
      body: { error: 'rate_limited', subject: 'network', retryAfter: net.retryAfterSec },
      headers: { 'retry-after': String(net.retryAfterSec) },
    }
  }

  const keys = parseAgentApiKeys(options.agentApiKeys ?? process.env.AGENT_API_KEYS)
  if (keys.length === 0) {
    if (!warnedAuthDisabled) {
      warnedAuthDisabled = true
      console.warn(
        '[agent-auth] AGENT_API_KEYS is unset — builder endpoints are UNAUTHENTICATED (per-network rate limits still apply)',
      )
    }
    return { ok: true, keyId: null }
  }

  const presented = headers.get(AGENT_API_KEY_HEADER)?.trim() ?? null
  const keyId = resolveAgentKeyId(presented, keys)
  if (keyId == null) {
    return {
      ok: false,
      status: 401,
      body: { error: 'unauthorized' },
      headers: {},
    }
  }

  const key = checkWindow(store, `key:${keyId}`, limits.perKey, now)
  if (!key.allowed) {
    return {
      ok: false,
      status: 429,
      body: { error: 'rate_limited', subject: 'api_key', retryAfter: key.retryAfterSec },
      headers: { 'retry-after': String(key.retryAfterSec) },
    }
  }
  return { ok: true, keyId }
}
