// Meteora DBC constants — mainnet only

/**
 * The dbc-config record's production default (tests/config-record.test.ts
 * pins it). Not read at runtime: the launch catalog comes from the backend's
 * mobile-config on every request.
 */
export const DEFAULT_DBC_CONFIG_KEY = 'B3Nwr5oZJXw4CxE5CURSup3MzxpiDbQSy1mpfvv6KMn2'
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112'

export const KNOWN_MINTS: Record<string, { symbol: string; decimals: number }> = {
  [NATIVE_MINT]: { symbol: 'SOL', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
}

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
/**
 * Config keys whose coins stay listed and claimable although the catalog no
 * longer serves them for new launches (retired launch configs). Mirrors the
 * app's `config/production-manifest.json` `targets.production.partnerConfigKeys`.
 * Comma-separated base58 pubkeys, read at call time; unset → catalog keys only.
 */
export function getListedConfigKeys(): string[] {
  return parseBase58List(process.env.LISTED_CONFIG_KEYS)
}

/**
 * Token-2022 transfer-fee launch configs offered as extra MEMECOIN options on
 * top of the backend-served catalog. `/api/mobile-config` never serves them:
 * the app picks them as transfer-fee "twins" behind its own flag. Mirrors the
 * values of the app's `config/production-manifest.json`
 * `targets.production.transferFeeConfigKeys`. Comma-separated base58 pubkeys,
 * read at call time; unset → none offered.
 */
export function getTransferFeeConfigKeys(): string[] {
  return parseBase58List(process.env.TRANSFER_FEE_CONFIG_KEYS)
}

function parseBase58List(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(entry))
}

export function getDonationClaimAuthorities(): string[] {
  return parseBase58List(process.env.DONATION_CLAIM_AUTHORITIES)
}
