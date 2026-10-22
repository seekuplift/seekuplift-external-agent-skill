/**
 * backend-rs-sql client. Every call that resolves the caller's geo verdict or
 * rate-limit bucket forwards the caller's IP: the production deployment
 * colocates this service with the backend (127.0.0.1), and the backend only
 * trusts `X-Forwarded-For` from a loopback peer — so geo verdicts and the
 * 10/hour upload budget apply to the calling agent, not to the service host.
 */
import { isIP } from 'node:net'
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
  // Valid IPv4/IPv6 literal only. No x-real-ip fallback: Caddy strips it and
  // the backend ignores it.
  return isIP(first) !== 0 ? first : null
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

/**
 * A non-2xx response from a backend POST. `status` is the backend's HTTP
 * status; `body` is its parsed error object when it was JSON
 * (`{ error: "geo_restricted", region, feature, status }` and friends) —
 * callers may surface both to the agent unchanged.
 */
export class BackendHttpError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'BackendHttpError'
    this.status = status
    this.body = body
  }
}

async function readBackendError(response: Response, label: string): Promise<BackendHttpError> {
  let body: unknown = null
  try {
    const text = await response.text()
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  } catch {
    body = null
  }
  const code =
    body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : null
  return new BackendHttpError(
    code ?? `Backend ${label} failed: ${response.status}`,
    response.status,
    body,
  )
}

/**
 * POST a JSON body to the backend, forwarding `clientIp` as
 * `X-Forwarded-For`. Throws `BackendHttpError` on a non-2xx response.
 */
export async function backendPostJson<T>(
  path: string,
  body: unknown,
  options: { clientIp?: string | null; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...options.headers,
    accept: 'application/json',
    'content-type': 'application/json',
  }
  if (options.clientIp) headers['x-forwarded-for'] = options.clientIp
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw await readBackendError(response, `POST ${path}`)
  }
  return (await response.json()) as T
}

/**
 * POST a multipart/form-data body to the backend, forwarding `clientIp` as
 * `X-Forwarded-For`. Throws `BackendHttpError` on a non-2xx response.
 */
export async function backendPostForm<T>(
  path: string,
  form: FormData,
  options: { clientIp?: string | null; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers, accept: 'application/json' }
  if (options.clientIp) headers['x-forwarded-for'] = options.clientIp
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw await readBackendError(response, `POST ${path}`)
  }
  return (await response.json()) as T
}
