// Meteora DBC constants — mainnet only

/**
 * The production-indexed pool config — the launch default when a (v1-shaped)
 * request omits `configKey`, and the key the pools filter's catalog always
 * serves. `4w9Rs2ew…` (the April 2026 default) is NOT indexed by the
 * production backend: coins launched on it never appear in the app.
 * Both contract documents (SKILL.v1.md, public/skill.json) name this value —
 * tests/skill-docs.test.ts pins them to this one source constant.
 */
export const DEFAULT_DBC_CONFIG_KEY = '61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv'
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112'

export const KNOWN_MINTS: Record<string, { symbol: string; decimals: number }> = {
  [NATIVE_MINT]: { symbol: 'SOL', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
}

/**
 * The frozen v1 contract (`/skill.md`, `/skill.json`, `/v1/*`) is served
 * until this date, then retired — the date is stated in both versions' docs
 * and CHANGELOG.md; tests pin them to this constant.
 */
export const V1_CONTRACT_SUNSET = '2027-01-15'

/** Default slippage ceiling (10%) for the trade endpoints and the launch first buy. */
export const MAX_SLIPPAGE_BPS = 1_000
/** Ceiling with `allowHighSlippage: true` (50%) — the floor is never zero. */
export const HIGH_SLIPPAGE_MAX_BPS = 5_000

export const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

/**
 * TB-S-3 transport rule: a REMOTE backend URL must be https — plain-http to
 * a remote host would let a MITM rewrite the unsigned transactions this
 * service builds. The only allowed http transport is the colocated loopback
 * deployment (plan §Hosting: this service calls the backend on 127.0.0.1
 * and the backend trusts `X-Forwarded-For` only from loopback). Anything
 * else fails closed at startup.
 */
export function assertBackendTransport(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`BACKEND_URL is not a valid URL: ${url}`)
  }
  if (parsed.protocol === 'https:') return url
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const octets = host.split('.').map(Number)
    const isLoopback =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      (octets.length === 4 &&
        octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) &&
        octets[0] === 127)
    if (isLoopback) return url
  }
  throw new Error(
    `BACKEND_URL must be https for a remote backend, or the colocated loopback (http://127.0.0.1:3000) — got ${url}`,
  )
}

export const BACKEND_URL = assertBackendTransport(
  (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
)

/**
 * No storage credentials live here: uploads go through the backend proxy
 * (`/api/upload/*` on backend-rs-sql), which owns the Filebase key.
 */

/**
 * Donation claim authorities — the feeClaimer values that make a config
 * cause-capable (app's `EXPO_PUBLIC_DONATION_CLAIM_AUTHORITY`, sourced from
 * the app's `config/production-manifest.json`
 * `targets.production.donationClaimAuthorities`). Comma-separated base58
 * pubkeys. Read at call time so deploys/tests can change it without a
 * restart. Fail closed: unset/empty → no config is cause-capable.
 */
export function getDonationClaimAuthorities(): string[] {
  const raw = process.env.DONATION_CLAIM_AUTHORITIES ?? ''
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(entry))
}
