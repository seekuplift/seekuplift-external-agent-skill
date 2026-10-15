/**
 * Per-caller geo verdict handling, ported from the app's
 * src/domain/geo-access.ts. The verdict arrives on `GET /api/mobile-config`'s
 * `geo` field (`{ region, restricted, betaGated }`), computed fresh by the
 * backend per request — this service re-fetches it on every call and never
 * caches it.
 *
 * Fail OPEN (app rule D4): an unreadable or missing `geo` field yields the
 * open verdict — nothing restricted.
 */

/** The backend's create/trade feature keys (subset we gate on). */
export type GeoFeatureKey =
  | 'idea.create'
  | 'idea.trade'
  | 'startup.create'
  | 'startup.trade'
  | 'stock.create'
  | 'stock.trade'

/** Cause restriction keys — display rules in the app; `cause.marketing`
 *  doubles as the memecoin launch gate (there is no `meme.create`). */
export type CauseGeoKey =
  | 'cause.specific_hidden'
  | 'cause.managed_hidden'
  | 'cause.info_hidden'
  | 'cause.marketing'

/** Canonical serialization order — matches the backend `Feature` enum order. */
const GEO_FEATURE_KEYS: readonly GeoFeatureKey[] = [
  'idea.create',
  'idea.trade',
  'startup.create',
  'startup.trade',
  'stock.create',
  'stock.trade',
]

const CAUSE_GEO_KEYS: readonly CauseGeoKey[] = [
  'cause.specific_hidden',
  'cause.managed_hidden',
  'cause.info_hidden',
  'cause.marketing',
]

/**
 * The requester's geo verdict, echoing `geo` on `/api/mobile-config`:
 * `region` is the resolved ISO code echoed only to this requester (`null`
 * when the backend could not resolve one); `restricted` is the union of
 * matching rule entries in canonical order.
 */
export type GeoVerdict = {
  region: string | null
  restricted: (GeoFeatureKey | CauseGeoKey)[]
  betaGated: boolean
}

/** The pre-read / fail-open verdict. */
export const OPEN_GEO_VERDICT: GeoVerdict = {
  region: null,
  restricted: [],
  betaGated: false,
}

/**
 * Tolerant wire parse of the `geo` field. Anything that is not a
 * `{ region: string|null, restricted: [...] }` object yields the open
 * verdict. Unknown keys drop (forward compatibility), duplicates collapse,
 * `restricted` emits in canonical order regardless of wire order.
 */
export function parseGeoVerdict(raw: unknown): GeoVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return OPEN_GEO_VERDICT
  }
  const record = raw as {
    region?: unknown
    restricted?: unknown
    betaGated?: unknown
  }
  const region =
    typeof record.region === 'string' && record.region.trim() ? record.region.trim() : null
  const wireRestricted: unknown[] = Array.isArray(record.restricted) ? record.restricted : []
  const restricted = [...GEO_FEATURE_KEYS, ...CAUSE_GEO_KEYS].filter((key) =>
    wireRestricted.includes(key),
  )
  return { region, restricted, betaGated: record.betaGated === true }
}

export type LaunchCategory = 'meme' | 'idea' | 'startup'

export type GeoCreateVerdict = {
  allowed: boolean
  /** The restricted feature key that blocks the launch, or null. */
  reason: string | null
  /** The requester's resolved region, echoed; null when unresolved. */
  region: string | null
}

/**
 * Feature keys a trade (buy OR sell — the app resolves them identically, D5)
 * on one coin is gated by, mirroring the app's `featuresForCoin`:
 *   - idea/startup coins → `<category>.trade`
 *   - stock-quoted coins → `stock.trade` (a coin may match both legs; any
 *     match restricts)
 *   - `meme` and unknown categories are never trade-gated (fail open, D4).
 */
export function tradeFeatureKeys(
  category: string | null | undefined,
  isStock: boolean,
): string[] {
  const keys: string[] = []
  const normalized = category?.trim()
  if (normalized === 'idea' || normalized === 'startup') {
    keys.push(`${normalized}.trade`)
  }
  if (isStock) keys.push('stock.trade')
  return keys
}

/**
 * The caller's trade verdict for one coin. `allowed` when none of the coin's
 * trade feature keys is in the verdict's restricted list; `reason` is the
 * first matching restricted key (canonical order).
 */
export function resolveTradeGeo(
  verdict: GeoVerdict | null | undefined,
  category: string | null | undefined,
  isStock: boolean,
): GeoCreateVerdict {
  const keys = tradeFeatureKeys(category, isStock)
  const restricted = keys.find((key) => verdict?.restricted.includes(key as never))
  return {
    allowed: restricted == null,
    reason: restricted ?? null,
    region: verdict?.region ?? null,
  }
}

/**
 * Feature keys a create on one category is gated by, as the backend enforces
 * at `POST /api/upload/metadata`:
 *   - idea/startup → `<category>.create`
 *   - meme → `cause.marketing` (there is no `meme.create`; the donation-kind
 *     hidden-key check happens at launch time)
 *   - a stock-quoted config additionally carries `stock.create` — the backend
 *     does not check it at upload, so this service is the only gate.
 */
export function createFeatureKeys(category: LaunchCategory, isStock: boolean): string[] {
  const keys: string[] = []
  if (category === 'idea' || category === 'startup') {
    keys.push(`${category}.create`)
  } else if (category === 'meme') {
    keys.push('cause.marketing')
  }
  if (isStock) keys.push('stock.create')
  return keys
}

/**
 * The caller's create verdict for one category on one config. `allowed`
 * when none of the category's feature keys is in the verdict's restricted
 * list; `reason` is the first matching restricted key. A meme launch is also
 * refused with reason `beta.gated` when the caller's region is beta-gated.
 */
export function resolveCreateGeo(
  verdict: GeoVerdict | null | undefined,
  category: LaunchCategory,
  isStock: boolean,
): GeoCreateVerdict {
  const keys = createFeatureKeys(category, isStock)
  let restricted = keys.find((key) => verdict?.restricted.includes(key as never))
  // Owner rule (2026-10-15): memecoin launches are blocked in every
  // beta-gated jurisdiction — agents have no beta admission path.
  if (restricted == null && category === 'meme' && verdict?.betaGated) restricted = 'beta.gated'
  return {
    allowed: restricted == null,
    reason: restricted ?? null,
    region: verdict?.region ?? null,
  }
}

/** English country name for an ISO region code, or null when unknown. */
export function regionDisplayName(region: string | null): string | null {
  if (!region) return null
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(region.toUpperCase())
    return name && name !== region.toUpperCase() && name !== 'Unknown Region' ? name : null
  } catch {
    return null
  }
}

/** The user-facing refusal sentence agents relay verbatim. */
export function geoBlockedMessage(region: string | null): string {
  const name = regionDisplayName(region)
  const where = name ? `${name} (${region!.toUpperCase()})` : region ? region.toUpperCase() : 'your detected jurisdiction'
  return `This is not currently available in ${where}.`
}
