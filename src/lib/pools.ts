/**
 * `GET /api/pools` — pool listing and search across EVERY catalog config.
 *
 * The backend's stream surface is keyed by `partnerConfigs`. This module
 * resolves the catalog's served config keys — the same allowlist
 * `GET /api/configs` is built from (`/api/mobile-config`
 * `launchConfigOptions`, parse cached ~60s keyed on the response `version`)
 * — and proxies:
 *
 *   - `?search=<q>` → `GET /api/stream/search` (q, partnerConfigs, limit)
 *   - otherwise     → `GET /api/stream/list`   (partnerConfigs, limit,
 *                                               cursor, tab, category,
 *                                               lifecycle, sortBy)
 *
 * Both calls forward the caller IP as `X-Forwarded-For` so the backend's
 * per-IP read bucket applies to the calling agent (colocated deployment —
 * the backend only trusts XFF from loopback).
 *
 * When the catalog serves no config keys the response is an empty list: the
 * backend falls back to its env `stream_partner_configs` on an empty
 * `partnerConfigs`, which can include keys the catalog does not serve — an
 * empty result is the correct catalog answer, never the env fallback.
 * Pools whose `configKey` is not a served catalog key are dropped
 * client-side too (the app's `usesConfiguredPartnerKey` rule).
 *
 * Price, market-cap and volume figures are backend f64 display-grade data
 * (`price`/`marketCap`/`volume24h` are USD, `nativePrice` is
 * quote-denominated) — never inputs to a money path.
 */
import { backendGetJson } from './backend.ts'
import {
  getMobileConfigContext,
  type CatalogDeps,
  type LaunchConfigOptionsByCategory,
} from './config-catalog.ts'
import type { LaunchCategory } from './geo.ts'
import { LaunchError } from './launch.ts'

/** A pools-surface refusal with an HTTP status (400-class client errors). */
export class PoolsError extends LaunchError {
  constructor(message: string, status = 400, fields: Record<string, unknown> = {}) {
    super(message, status, fields)
    this.name = 'PoolsError'
  }
}

const CATEGORIES: readonly LaunchCategory[] = ['meme', 'idea', 'startup']

// `/api/stream/list` controls — validated here so a bad value is a clean
// 400 instead of a backend 400 surfaced as a 502.
const LIST_TABS = new Set(['emerging', 'graduated'])
const LIST_CATEGORIES = new Set(CATEGORIES)
const LIST_LIFECYCLES = new Set(['new'])
const LIST_SORTS = new Set(['createdAt', 'createdAtAsc', 'volume24h', 'marketCap'])

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100 // both backend endpoints clamp to 100

/**
 * Raw query params as the route reads them (strings or null). `search`,
 * `limit`, `cursor` mirror the legacy contract plus the list endpoint's
 * pagination; `tab`/`category`/`lifecycle`/`sortBy` pass through to
 * `/api/stream/list` (ignored on a search, as the backend ignores them).
 */
export type ListPoolsQuery = {
  search?: string | null
  limit?: string | null
  cursor?: string | null
  tab?: string | null
  category?: string | null
  lifecycle?: string | null
  sortBy?: string | null
}

/** The pool record `GET /api/pools` returns — legacy fields plus the
 * config/category/graduation context an agent needs to trade the coin. */
export type PoolSummary = {
  /** DBC pool address — the `poolAddress` `/api/trade/*` takes. */
  id: string | null
  name: string | null
  symbol: string | null
  baseMint: string | null
  icon: string | null
  description: string | null
  /** Backend-mirrored launch category ("meme" | "idea" | "startup"), null
   * until the coin's metadata is indexed. */
  launchType: string | null
  /** USD price (display-grade). */
  price: number | null
  /** Quote-denominated price (base token in units of `quoteSymbol`). */
  nativePrice: number | null
  quoteMint: string | null
  quoteSymbol: string | null
  priceChange24h: number | null
  /** USD market cap — backend effective price × total supply. */
  marketCap: number | null
  /** USD 24h volume. */
  volume24h: number | null
  /** True once the coin migrated off the curve — trade it on Jupiter, not
   * `/api/trade/*` (which refuses non-`curve` pools). */
  graduated: boolean
  /** ms-since-epoch; null while ungraduated. */
  graduatedAt: number | null
  /** Bonding-curve progress 0..1 (always 1 on graduated pools; null when
   * the migration threshold is unknown). */
  bondingCurve: number | null
  /** The catalog config key this coin was launched on. */
  configKey: string
  /** ms-since-epoch. */
  createdAt: number | null
}

export type ListPoolsResult = {
  pools: PoolSummary[]
  /** Opaque keyset cursor for the next list page; null on the last page
   * and always null on search responses. */
  nextCursor: string | null
}

/** Injectable seams — `catalogDeps` forwards to `getMobileConfigContext`
 * (its `fetchMobileConfig`, clock); the stream calls themselves ride
 * `globalThis.fetch` through `backendGetJson`, which tests stub. */
export type PoolsDeps = {
  catalogDeps?: CatalogDeps
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Every served catalog config key, deduplicated, in canonical category
 * then option order — the `partnerConfigs` allowlist. */
export function catalogConfigKeys(options: LaunchConfigOptionsByCategory): string[] {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const category of CATEGORIES) {
    for (const ref of options[category] ?? []) {
      if (!seen.has(ref.configKey)) {
        seen.add(ref.configKey)
        keys.push(ref.configKey)
      }
    }
  }
  return keys
}

function parseLimit(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_LIMIT
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed)) {
    throw new PoolsError(`limit must be a number between 1 and ${MAX_LIMIT}`)
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT)
}

function parseEnum(
  raw: string | null | undefined,
  allowed: ReadonlySet<string>,
  field: string,
): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  if (!allowed.has(value)) {
    throw new PoolsError(
      `${field} must be one of: ${[...allowed].join(', ')}`,
      400,
      { error: `unsupported_${field}`, allowed: [...allowed] },
    )
  }
  return value
}

function mapStreamPool(raw: unknown): PoolSummary {
  const p = asRecord(raw)
  const base = asRecord(p.baseAsset)
  const quote = asRecord(p.quoteAsset)
  const graduatedAt = asNum(p.graduatedAt)
  return {
    id: asStr(p.id),
    name: asStr(base.name),
    symbol: asStr(base.symbol),
    baseMint: asStr(base.id),
    icon: asStr(base.icon),
    description: asStr(base.description),
    launchType: asStr(base.launchType),
    price: asNum(p.price),
    nativePrice: asNum(base.nativePrice),
    quoteMint: asStr(quote.id),
    quoteSymbol: asStr(quote.symbol),
    priceChange24h: asNum(p.priceChange24h),
    marketCap: asNum(p.marketCap),
    volume24h: asNum(p.volume24h),
    // `graduated` wins; a serialized `graduatedAt` is equally authoritative
    // (the app derives the same OR in classifyLifecycle).
    graduated: p.graduated === true || graduatedAt != null,
    graduatedAt,
    bondingCurve: asNum(p.bondingCurve),
    configKey: asStr(p.configKey) ?? '',
    createdAt: asNum(p.createdAt),
  }
}

export async function listPools(
  query: ListPoolsQuery,
  clientIp: string | null,
  deps: PoolsDeps = {},
): Promise<ListPoolsResult> {
  const search = query.search?.trim() ?? ''
  const limit = parseLimit(query.limit)
  const cursor = query.cursor?.trim() || undefined
  const tab = parseEnum(query.tab, LIST_TABS, 'tab')
  const category = parseEnum(query.category, LIST_CATEGORIES, 'category')
  const lifecycle = parseEnum(query.lifecycle, LIST_LIFECYCLES, 'lifecycle')
  const sortBy = parseEnum(query.sortBy, LIST_SORTS, 'sortBy')

  // Fresh mobile-config context per request (geo is per-caller; the option
  // parse rides the ~60s version cache) — the served keys ARE the catalog.
  const ctx = await getMobileConfigContext(clientIp, deps.catalogDeps)
  const keys = catalogConfigKeys(ctx.options)
  if (keys.length === 0) return { pools: [], nextCursor: null }
  const partnerConfigs = keys.join(',')
  const catalog = new Set(keys)

  // `usesConfiguredPartnerKey` parity: only pools on a served catalog key.
  const visible = (items: unknown[]): PoolSummary[] =>
    items.map(mapStreamPool).filter((pool) => catalog.has(pool.configKey))

  if (search) {
    const raw = await backendGetJson<unknown>(
      '/api/stream/search',
      { q: search, partnerConfigs, limit: String(limit) },
      { clientIp },
    )
    return { pools: visible(Array.isArray(raw) ? raw : []), nextCursor: null }
  }

  const raw = await backendGetJson<unknown>(
    '/api/stream/list',
    {
      partnerConfigs,
      limit: String(limit),
      cursor,
      tab,
      category,
      lifecycle,
      sortBy,
    },
    { clientIp },
  )
  const body = asRecord(raw)
  const items = Array.isArray(body.items) ? body.items : []
  return {
    pools: visible(items),
    nextCursor: asStr(body.nextCursor),
  }
}
