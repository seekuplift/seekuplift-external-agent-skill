/**
 * backend-rs-sql client. Every call that resolves the caller's geo verdict or
 * rate-limit bucket forwards the caller's IP: the production deployment
 * colocates this service with the backend (127.0.0.1), and the backend only
 * trusts `X-Forwarded-For` from a loopback peer — so geo verdicts and the
 * 10/hour upload budget apply to the calling agent, not to the service host.
 */
import { BACKEND_URL } from './config.ts'

/**
 * Extract the caller's client IP from an incoming request's headers. Behind
 * Caddy the `x-forwarded-for` chain is rewritten to the real client IP, so the
 * FIRST entry is the caller. Returns null (→ no forwarding; the backend then
 * resolves against this service's own address) for absent/malformed values —
 * never forwards a spoofable middle hop.
 */
export function clientIpFromHeaders(
  headers: Pick<Headers, 'get'> | Record<string, string | string[] | undefined>,
): string | null {
  const raw =
    typeof (headers as Pick<Headers, 'get'>).get === 'function'
      ? (headers as Pick<Headers, 'get'>).get('x-forwarded-for')
      : (headers as Record<string, string | string[] | undefined>)['x-forwarded-for']
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim() ?? ''
  // IPv4 or IPv6 literal — anything else is not forwarded.
  if (/^[0-9a-fA-F.:]{3,45}$/.test(first)) return first
  const realIp =
    typeof (headers as Pick<Headers, 'get'>).get === 'function'
      ? (headers as Pick<Headers, 'get'>).get('x-real-ip')
      : (headers as Record<string, string | string[] | undefined>)['x-real-ip']
  const real = (Array.isArray(realIp) ? realIp[0] : realIp)?.trim() ?? ''
  return /^[0-9a-fA-F.:]{3,45}$/.test(real) ? real : null
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * GET a JSON endpoint on the backend, forwarding `clientIp` as
 * `X-Forwarded-For`. Throws on a non-2xx response or a body that is not JSON.
 */
export async function backendGetJson<T>(
  path: string,
  params: Record<string, string | undefined>,
  options: { clientIp?: string | null; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(`${BACKEND_URL}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value)
  }
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.clientIp) headers['x-forwarded-for'] = options.clientIp
  const response = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Backend GET ${path} failed: ${response.status}`)
  }
  return (await response.json()) as T
}
