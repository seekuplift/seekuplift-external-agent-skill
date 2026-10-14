/**
 * Launch metadata + claim domain logic.
 *
 * Ported from the app (launchpad-mobile-redesign):
 *   - src/domain/launch-flow.ts — identity canonicalization + limits,
 *     `buildLaunchMetadataShape` (metadata JSON), `normalizeDonationProjectId`,
 *     `categorySupportsDonation`;
 *   - src/domain/coin-edit.ts — `normalizeLinkUrl`;
 *   - src/domain/cause-funding.ts — donation mode vocabulary, launch-mode
 *     resolution and the `donationFunding` claim builder;
 *   - src/domain/idea-funding.ts — idea-funding mode vocabulary, normalizers
 *     and the `ideaFunding` claim builder;
 *   - src/domain/use-case-categories.ts — the idea/startup use-case slug
 *     catalogs (labels/icons/keywords dropped; only the slugs + aliases the
 *     serializer needs);
 * and from the backend (backend-rs-sql):
 *   - src/impact/policy/cause_funding/mod.rs `extract_claim` +
 *     `decide_with_registry` and kind.rs `classify_upload_claim` — the claim
 *     classification the `/api/upload/metadata` geo refusal applies to a meme
 *     launch's donation claim.
 */
import { PublicKey } from '@solana/web3.js'

// ─── Identity limits + canonicalization (app: launch-flow.ts) ─────────────────

export const LAUNCH_NAME_MAX_UTF8_BYTES = 32
export const LAUNCH_SYMBOL_MAX_UTF8_BYTES = 10
export const LAUNCH_NAME_MIN_CODE_POINTS = 3
export const LAUNCH_DESCRIPTION_MAX_CODE_POINTS = 2000

function codePointLength(value: string): number {
  return [...value].length
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** True when the string carries an unpaired UTF-16 surrogate. */
export function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
}

/**
 * The canonical ticker: a leading run of "$" and Unicode whitespace is
 * stripped, the remainder is trimmed and uppercased.
 */
export function canonicalizeLaunchSymbol(raw: string): string {
  return raw.replace(/^[$\s]+/u, '').trim().toUpperCase()
}

/** The canonical identity strings — the values validation and the chain use. */
export function canonicalizeLaunchIdentity(form: {
  name: string
  symbol: string
  description: string
}): { name: string; symbol: string; description: string } {
  return {
    name: form.name.trim(),
    symbol: canonicalizeLaunchSymbol(form.symbol),
    description: form.description.trim(),
  }
}

/** Why an identity field is invalid, or null — mirrors the app's validator. */
export function launchIdentityError(
  field: 'name' | 'symbol' | 'description',
  value: string,
): string | null {
  const canonical =
    field === 'symbol' ? canonicalizeLaunchSymbol(value) : value.trim()
  if (field === 'name') {
    if (!canonical) return 'name is required'
    if (codePointLength(canonical) < LAUNCH_NAME_MIN_CODE_POINTS)
      return `name must be at least ${LAUNCH_NAME_MIN_CODE_POINTS} characters`
    if (hasLoneSurrogate(canonical) || utf8ByteLength(canonical) > LAUNCH_NAME_MAX_UTF8_BYTES)
      return `name must be at most ${LAUNCH_NAME_MAX_UTF8_BYTES} UTF-8 bytes`
    return null
  }
  if (field === 'symbol') {
    if (!canonical) return 'symbol is required'
    if (hasLoneSurrogate(canonical) || utf8ByteLength(canonical) > LAUNCH_SYMBOL_MAX_UTF8_BYTES)
      return `symbol must be at most ${LAUNCH_SYMBOL_MAX_UTF8_BYTES} UTF-8 bytes`
    return null
  }
  // description
  if (!canonical || hasLoneSurrogate(canonical)) return 'description is required'
  if (codePointLength(canonical) > LAUNCH_DESCRIPTION_MAX_CODE_POINTS)
    return `description must be at most ${LAUNCH_DESCRIPTION_MAX_CODE_POINTS} characters`
  return null
}

// ─── Link normalizers (app: coin-edit.ts + launch-flow.ts) ────────────────────

export function normalizeLinkUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('://')) return trimmed
  return `https://${trimmed}`
}

/** Accept an X username while storing a browser-openable profile URL. */
export function normalizeLaunchXUrl(value: string): string {
  const trimmed = value.trim()
  const handle = trimmed.replace(/^@/, '')
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : trimmed
}

/** Preserve explicit document URI schemes; infer HTTPS for scheme-less links. */
export function normalizeLaunchDocumentUri(value: string): string {
  const trimmed = value.trim()
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) ? trimmed : normalizeLinkUrl(trimmed)
}

// ─── Use-case slugs (app: use-case-categories.ts) ─────────────────────────────

export const MAX_USE_CASES = 3

const IDEA_USE_CASE_SLUGS: readonly string[] = [
  'climate', 'education', 'inclusion', 'local', 'depin', 'desci',
  'public-goods', 'infrastructure', 'payments', 'governance', 'social',
  'art', 'gaming', 'defi', 'privacy', 'identity', 'health', 'energy',
  'food', 'housing', 'mobility', 'other',
]

const STARTUP_USE_CASE_SLUGS: readonly string[] = [
  'saas', 'consumer', 'fintech', 'ai', 'infrastructure', 'defi', 'payments',
  'depin', 'gaming', 'rwa', 'social', 'data', 'creator', 'climate',
  'education', 'health', 'security', 'wallet', 'marketplace', 'media',
  'stablecoins', 'other',
]

const IDEA_SLUG_SET = new Set(IDEA_USE_CASE_SLUGS)
const STARTUP_SLUG_SET = new Set(STARTUP_USE_CASE_SLUGS)

/** Historical display values → canonical slug (lowercased keys). */
const USE_CASE_ALIAS_TO_SLUG: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const slug of new Set([...IDEA_USE_CASE_SLUGS, ...STARTUP_USE_CASE_SLUGS])) {
    map.set(slug, slug)
  }
  const aliases: [string, string][] = [
    ['climate', 'climate'], ['education', 'education'], ['local economy', 'local'],
    ['local solution', 'local'], ['local_solution', 'local'], ['hardware', 'depin'],
    ['public goods', 'public-goods'], ['public_goods', 'public-goods'],
    ['infrastructure', 'infrastructure'], ['defi', 'defi'], ['gaming', 'gaming'],
    ['art', 'art'], ['social', 'social'], ['consumer app', 'consumer'],
    ['consumer_app', 'consumer'], ['infra', 'infrastructure'], ['other', 'other'],
  ]
  for (const [alias, slug] of aliases) map.set(alias.trim().toLowerCase(), slug)
  return map
})()

const LAUNCH_TYPE_VALUES = new Set(['meme', 'idea', 'startup'])

function normalizeUseCaseSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (!key || LAUNCH_TYPE_VALUES.has(key)) return null
  return USE_CASE_ALIAS_TO_SLUG.get(key) ?? null
}

/**
 * Normalize a use-case list (or single value) to unique canonical slugs in
 * first-seen order, truncated to MAX_USE_CASES. Comma- and ` · `-joined
 * strings expand to multiple entries; unknown values drop.
 */
export function normalizeUseCaseSlugs(raw: unknown): string[] {
  const expand = (item: unknown): string[] => {
    if (Array.isArray(item)) return item.flatMap(expand)
    if (typeof item !== 'string') return []
    const trimmed = item.trim()
    if (!trimmed) return []
    if (trimmed.includes(',') || trimmed.includes('·')) {
      return trimmed.split(/[,·]/).map((part) => part.trim()).filter(Boolean)
    }
    return [trimmed]
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of expand(raw)) {
    const slug = normalizeUseCaseSlug(item)
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
    if (out.length >= MAX_USE_CASES) break
  }
  return out
}

/** Keep slugs that exist on the given category's closed list. */
export function useCaseSlugsInCatalog(slugs: readonly string[], category: 'idea' | 'startup'): string[] {
  const allowed = category === 'idea' ? IDEA_SLUG_SET : STARTUP_SLUG_SET
  return slugs.filter((slug) => allowed.has(slug))
}

// ─── Donation claims (app: cause-funding.ts) ──────────────────────────────────

/**
 * Donation modes a launch pick may name. `cause`/`project` carry their own
 * metadata fields (`donationCause`/`donationProject`); `managed`/`tbd`/`x`/
 * `reddit` ride `donationFunding`.
 */
export const CAUSE_FUNDING_LAUNCH_MODES = [
  'managed',
  'cause',
  'project',
  'tbd',
  'x',
  'reddit',
] as const
export type CauseFundingLaunchMode = (typeof CAUSE_FUNDING_LAUNCH_MODES)[number]

/** The modes offered when `GET /api/cause-funding/modes` fails. */
export const CAUSE_FUNDING_FALLBACK_MODES: readonly string[] = ['managed', 'cause', 'project']

export const CAUSE_FUNDING_SOCIAL_MODES = ['x', 'reddit'] as const

/** One registry row as served by `GET /api/cause-funding/modes`. */
export type CauseFundingModeInfo = {
  mode?: string
  status?: string
  pickers?: string[]
  isFinal?: boolean
  launchEnabled?: boolean
  explainerKey?: string
}

export type CauseFundingModesResponse = {
  modes?: CauseFundingModeInfo[]
  fallbackMode?: string
}

/**
 * The donation modes a launch may claim: `null` registry → the spec's
 * fallback triple; a fetched registry → its ACTIVE, launch-enabled,
 * launch-pickable modes in registry order.
 */
export function causeFundingLaunchModes(
  registryModes: CauseFundingModeInfo[] | null | undefined,
): string[] {
  if (registryModes == null) return [...CAUSE_FUNDING_FALLBACK_MODES]
  return registryModes
    .filter(
      (entry) =>
        typeof entry.mode === 'string' &&
        entry.status === 'active' &&
        entry.launchEnabled === true &&
        (entry.pickers ?? []).includes('launch') &&
        (CAUSE_FUNDING_LAUNCH_MODES as readonly string[]).includes(entry.mode),
    )
    .map((entry) => entry.mode as string)
}

/** The mode every unresolved pick lands at (backend fallbackMode). */
export const CAUSE_FUNDING_DEFAULT_MODE = 'managed'

/** X handle rules: 1–15 letters/digits/underscores, stored lowercase without `@`. */
const X_HANDLE_RE = /^[a-z0-9_]{1,15}$/
/** Reddit username rules: 3–20 letters/digits/hyphens/underscores, case preserved. */
const REDDIT_HANDLE_RE = /^[A-Za-z0-9_-]{3,20}$/

/**
 * Normalize a creator-entered social handle to the canonical claim form, or
 * null when the format is wrong. Shared by donation and idea-funding claims
 * (the backend applies the same `normalize_x_handle`/`normalize_reddit_handle`
 * to both — launch_claim.rs):
 *   - x: trim, strip leading `@`, lowercase, 1–15 of `[a-z0-9_]`;
 *   - reddit: trim, strip leading `u/`/`/u/`, 3–20 of `[A-Za-z0-9_-]`,
 *     CASE PRESERVED (the claim stores provenance, not a lock).
 */
export function normalizeFundingHandle(
  platform: 'x' | 'reddit',
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (platform === 'x') {
    const handle = trimmed.replace(/^@+/, '').toLowerCase()
    return X_HANDLE_RE.test(handle) ? handle : null
  }
  // `trim_start_matches` semantics: repeated `u/` strips, then repeated `/u/` strips.
  const handle = trimmed.replace(/^(?:u\/)+/, '').replace(/^(?:\/u\/)+/, '').trim()
  return REDDIT_HANDLE_RE.test(handle) ? handle : null
}

/** A resolved Reddit `t2_` fullname — mirrors the backend's normalizer. */
export function normalizeFundingRedditUserId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && /^t2_[0-9a-z]{3,}$/.test(trimmed) ? trimmed : null
}

/**
 * Normalize a launcher-chosen Giveth project id to the bare-digit string the
 * backend accepts, or null. `parse_project_id` additionally requires a
 * positive value within i64 — enforced here so a written claim always parses.
 */
export function normalizeDonationProjectId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return null
  try {
    const id = BigInt(trimmed)
    // i64 positive range, matching the backend's `trimmed.parse::<i64>() > 0`.
    return id > 0n && id <= 9223372036854775807n ? trimmed : null
  } catch {
    return null
  }
}

/** The metadata `donationFunding` value — `{ mode, params }`. */
export type DonationFundingClaim = {
  mode: string
  params: Record<string, string>
}

export type DonationFundingClaimParams = {
  handle?: string | null
  /** `reddit`: the `t2_` id returned by the handle resolver. */
  redditUserId?: string | null
}

/**
 * Builds the `donationFunding` metadata claim for a resolved launch mode.
 * `managed`/`tbd` take no params; `x` carries the normalized handle;
 * `reddit` carries the resolved `t2_` id plus the normalized handle.
 * Returns null for `cause`/`project` (their own fields), an unknown or
 * planned mode, or a pick whose params cannot be normalized.
 */
export function buildDonationFundingClaim(
  mode: string,
  params: DonationFundingClaimParams = {},
): DonationFundingClaim | null {
  switch (mode) {
    case 'managed':
    case 'tbd':
      return { mode, params: {} }
    case 'x': {
      const handle = normalizeFundingHandle('x', params.handle)
      return handle ? { mode: 'x', params: { handle } } : null
    }
    case 'reddit': {
      const handle = normalizeFundingHandle('reddit', params.handle)
      const platformUserId = normalizeFundingRedditUserId(params.redditUserId)
      return handle && platformUserId
        ? { mode: 'reddit', params: { platformUserId, handle } }
        : null
    }
    default:
      return null
  }
}

// ─── Idea-funding claims (app: idea-funding.ts) ───────────────────────────────

/** Modes the launch flow implements, in listing order. */
export const IDEA_FUNDING_LAUNCH_MODES = [
  'managed',
  'tbd',
  'realms',
  'direct',
  'x',
  'reddit',
] as const
export type IdeaFundingLaunchMode = (typeof IDEA_FUNDING_LAUNCH_MODES)[number]

/**
 * Modes withheld from every launch pick even while the registry offers them
 * (`managed` + `realms` per owner decisions 2026-10-02/03).
 */
export const IDEA_FUNDING_UNAVAILABLE_MODES: readonly string[] = ['managed', 'realms']

/** The modes offered when `GET /api/idea-funding/modes` fails. */
export const IDEA_FUNDING_FALLBACK_MODES: readonly string[] = ['direct', 'tbd']

/** One registry row as served by `GET /api/idea-funding/modes`. */
export type IdeaFundingModeInfo = {
  mode?: string
  status?: string
  pickers?: string[]
  isFinal?: boolean
  payoutsEnabled?: boolean
}

export type IdeaFundingModesResponse = {
  modes?: IdeaFundingModeInfo[]
  takeoverMode?: string
  milestonesEnabled?: boolean
}

/**
 * The modes a launch may claim: `null` registry → the fallback pair; a
 * fetched registry → its ACTIVE, launch-pickable modes in registry order,
 * minus `IDEA_FUNDING_UNAVAILABLE_MODES`.
 */
export function ideaFundingLaunchModes(
  registryModes: IdeaFundingModeInfo[] | null | undefined,
): string[] {
  if (registryModes == null) return [...IDEA_FUNDING_FALLBACK_MODES]
  return registryModes
    .filter(
      (entry) =>
        typeof entry.mode === 'string' &&
        entry.status === 'active' &&
        (entry.pickers ?? []).includes('launch') &&
        (IDEA_FUNDING_LAUNCH_MODES as readonly string[]).includes(entry.mode),
    )
    .map((entry) => entry.mode as string)
    .filter((mode) => !IDEA_FUNDING_UNAVAILABLE_MODES.includes(mode))
}

/**
 * The `direct` payout address: base58, decoding to exactly 32 bytes —
 * byte-for-byte the backend's `valid_solana_address` (trim, ≤ 64 chars).
 */
export function normalizeIdeaFundingAddress(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > 64) return null
  try {
    const bytes = new PublicKey(trimmed).toBytes()
    return bytes.length === 32 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * A NEW `direct` recipient named by the launch pick — the syntax rule above
 * plus `PublicKey.isOnCurve`: the address becomes the coin's entitled
 * ed25519 signer, so an off-curve address (a PDA) can never satisfy that path.
 */
export function normalizeIdeaFundingDirectSigner(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeIdeaFundingAddress(value)
  if (!normalized) return null
  try {
    return PublicKey.isOnCurve(new PublicKey(normalized).toBytes()) ? normalized : null
  } catch {
    return null
  }
}

/**
 * The metadata `ideaFunding` value — a bare mode string or a mode+params
 * object in the exact shapes the backend claim parser accepts.
 */
export type IdeaFundingClaim =
  | string
  | { mode: 'direct'; address: string }
  | { mode: 'x'; handle: string }
  | { mode: 'reddit'; userId: string; handle: string }

export type IdeaFundingClaimParams = {
  /** `direct`: the payout Solana address. */
  address?: string | null
  /** `x`/`reddit`: the creator-entered handle. */
  handle?: string | null
  /** `reddit`: the `t2_` id returned by the handle resolver. */
  redditUserId?: string | null
}

/**
 * Builds the `ideaFunding` metadata claim for a resolved launch mode.
 * `managed`/`tbd`/`realms` serialize as the bare mode string; `direct` as
 * `{ mode: "direct", address }`; `x` as `{ mode: "x", handle }`;
 * `reddit` as `{ mode: "reddit", userId, handle }`. Returns null for a
 * mode outside the launchable set or a pick whose params cannot be
 * normalized — the serializer then omits the field and the backend records
 * `tbd`, never a malformed claim.
 */
export function buildIdeaFundingClaim(
  mode: string,
  params: IdeaFundingClaimParams = {},
): IdeaFundingClaim | null {
  switch (mode) {
    case 'managed':
    case 'tbd':
    case 'realms':
      return mode
    case 'direct': {
      const normalized = normalizeIdeaFundingAddress(params.address)
      return normalized ? { mode: 'direct', address: normalized } : null
    }
    case 'x': {
      const handle = normalizeFundingHandle('x', params.handle)
      return handle ? { mode: 'x', handle } : null
    }
    case 'reddit': {
      const handle = normalizeFundingHandle('reddit', params.handle)
      const userId = normalizeFundingRedditUserId(params.redditUserId)
      return handle && userId ? { mode: 'reddit', userId, handle } : null
    }
    default:
      return null
  }
}

// ─── Donation-claim kind classification (backend: classify_upload_claim) ──────

/**
 * The cause kind a launch metadata document's donation claim resolves to —
 * a port of the backend's `classify_upload_claim` used by the
 * `/api/upload/metadata` geo refusal. This service mirrors it to refuse the
 * launch BEFORE uploading, so a refusal costs no upload budget.
 *
 * Backend rule (extract_claim + decide_with_registry under Verified):
 *   - no donation field, more than one, or a malformed one → `managed`
 *     (every degraded claim records the `managed` fallback);
 *   - `donationCause` non-empty string → `specific`;
 *   - `donationProject` parsing to a positive bare-integer id → `specific`,
 *     otherwise `managed`;
 *   - `donationFunding` resolves its mode against the registry: unrecognized,
 *     `planned` (`dao`), a mode outside the funding field's vocabulary
 *     (`cause`/`project`), a launch-disabled mode (`x`/`reddit` today) or
 *     bad params all → `managed`; `managed` → `managed`; `tbd` → `specific`.
 */
export type UploadClaimKind = 'specific' | 'managed'

const CLAIM_FIELDS = ['donationCause', 'donationProject', 'donationFunding'] as const
/** The funding field's vocabulary + the planned mode (backend registry). */
const FUNDING_FIELD_MODES = ['managed', 'tbd', 'x', 'reddit'] as const
const REGISTERED_MODES = [...FUNDING_FIELD_MODES, 'cause', 'project', 'dao'] as const
const PLANNED_MODES = new Set(['dao'])
const LAUNCH_DISABLED_MODES = new Set(['x', 'reddit'])

/** Port of the backend `parse_claim`: bare mode string or `{mode, params?, ...flat}`. */
function parseFundingClaimShape(
  claim: unknown,
): { mode: string; params: Record<string, unknown> } | null {
  if (typeof claim === 'string') {
    const mode = claim.trim()
    return mode ? { mode, params: {} } : null
  }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return null
  const obj = claim as Record<string, unknown>
  const modeRaw = obj.mode
  const mode = typeof modeRaw === 'string' ? modeRaw.trim() : ''
  if (!mode) return null
  const paramsField = obj.params
  let params: Record<string, unknown>
  if (paramsField == null) {
    params = {}
  } else if (typeof paramsField === 'object' && !Array.isArray(paramsField)) {
    params = { ...(paramsField as Record<string, unknown>) }
  } else {
    return null
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key !== 'mode' && key !== 'params' && !(key in params)) params[key] = value
  }
  return { mode, params }
}

/** Port of the backend `normalize_funding_params` validity check. */
function fundingParamsValid(mode: string, params: Record<string, unknown>): boolean {
  const get = (key: string): string | null =>
    typeof params[key] === 'string' ? (params[key] as string) : null
  switch (mode) {
    case 'managed':
    case 'tbd':
      return true
    case 'x':
      return normalizeFundingHandle('x', get('handle')) != null
    case 'reddit':
      // `platformUserId` (the `t2_` lock) is required; `handle` is optional
      // provenance — mirrors the backend `normalize_funding_params`.
      return normalizeFundingRedditUserId(get('platformUserId')) != null
    default:
      return false
  }
}

export function classifyUploadClaimKind(
  doc: Record<string, unknown> | null | undefined,
): UploadClaimKind {
  const present = CLAIM_FIELDS.filter(
    (field) => doc != null && doc[field] != null,
  )
  if (present.length === 0 || present.length > 1) return 'managed'
  const field = present[0]
  const value = doc![field]
  if (field === 'donationCause') {
    return typeof value === 'string' && value.trim() ? 'specific' : 'managed'
  }
  if (field === 'donationProject') {
    return typeof value === 'string' && normalizeDonationProjectId(value) != null
      ? 'specific'
      : 'managed'
  }
  // donationFunding
  const parsed = parseFundingClaimShape(value)
  if (!parsed) return 'managed'
  const { mode, params } = parsed
  if (!(REGISTERED_MODES as readonly string[]).includes(mode)) return 'managed'
  if (PLANNED_MODES.has(mode)) return 'managed'
  if (!(FUNDING_FIELD_MODES as readonly string[]).includes(mode)) return 'managed'
  if (LAUNCH_DISABLED_MODES.has(mode)) return 'managed'
  if (!fundingParamsValid(mode, params)) return 'managed'
  return mode === 'managed' ? 'managed' : 'specific'
}

// ─── Metadata shape (app: buildLaunchMetadataShape) ───────────────────────────

export type LaunchCategory = 'meme' | 'idea' | 'startup'

/** The metadata JSON shape uploaded through the backend proxy. */
export type LaunchMetadataShape = {
  name: string
  symbol: string
  description: string
  image: string
  external_url?: string
  twitter?: string
  telegram?: string
  discord?: string
  launchType: LaunchCategory
  creatorAddress: string
  createdAt: string
  useCaseData?: {
    problemStatement?: string
    category?: string
    categories?: string[]
    whitepaper?: string
    discord?: string
    prototype?: string
  }
  startupData?: {
    pitch: string
    roadmap?: string
    discord?: string
    deck?: string
    legalFramework?: string
    legalFrameworkNote?: string
    tokenUtility?: string
    decentralizationEfforts?: string
    entityJurisdiction?: string
  }
  donationCause?: string
  donationProject?: string
  donationFunding?: DonationFundingClaim
  ideaFunding?: IdeaFundingClaim
}

export type LaunchMetadataInput = {
  /** Already-canonicalized identity. */
  name: string
  symbol: string
  description: string
  /** URL of the already-uploaded image. */
  imageUrl: string
  category: LaunchCategory
  creatorAddress: string
  website?: string
  twitter?: string
  telegram?: string
  discord?: string
  /** Normalized use-case slugs (idea/startup only). */
  useCases?: string[]
  /** idea → useCaseData.problemStatement; startup → startupData.pitch. */
  problem?: string
  whitepaper?: string
  prototype?: string
  deck?: string
  legalFramework?: string
  legalFrameworkNote?: string
  tokenUtility?: string
  decentralizationEfforts?: string
  entityJurisdiction?: string
  startupComplianceAcknowledged?: boolean
  /** At most one of the three keys — the resolved donation pick. */
  donationClaim?: {
    donationCause?: string
    donationProject?: string
    donationFunding?: DonationFundingClaim
  }
  ideaFundingClaim?: IdeaFundingClaim | null
}

/**
 * Builds the metadata JSON object — a port of the app's
 * `buildLaunchMetadataShape` over the service's already-validated request.
 * At most ONE donation claim field is ever written (the backend refuses a
 * metadata file carrying two).
 */
export function buildLaunchMetadata(input: LaunchMetadataInput): LaunchMetadataShape {
  const base: LaunchMetadataShape = {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: input.imageUrl,
    launchType: input.category,
    creatorAddress: input.creatorAddress,
    createdAt: new Date().toISOString(),
  }
  const website = input.website?.trim()
  const twitter = input.twitter?.trim()
  const telegram = input.telegram?.trim()
  const discord = input.discord?.trim()
  if (website) base.external_url = normalizeLinkUrl(website)
  if (twitter) base.twitter = normalizeLaunchXUrl(twitter)
  if (telegram) base.telegram = normalizeLinkUrl(telegram)
  if (discord) base.discord = normalizeLinkUrl(discord)

  const claim = input.donationClaim
  if (claim?.donationCause != null) base.donationCause = claim.donationCause
  else if (claim?.donationProject != null) base.donationProject = claim.donationProject
  else if (claim?.donationFunding != null) base.donationFunding = claim.donationFunding

  if (input.category === 'idea') {
    if (input.ideaFundingClaim != null) base.ideaFunding = input.ideaFundingClaim
    const useCaseData: NonNullable<LaunchMetadataShape['useCaseData']> = {
      problemStatement: (input.problem ?? '').trim(),
    }
    applyUseCaseTags(useCaseData, input.useCases)
    const whitepaper = input.whitepaper?.trim()
    const prototype = input.prototype?.trim()
    if (whitepaper) useCaseData.whitepaper = normalizeLaunchDocumentUri(whitepaper)
    if (discord) useCaseData.discord = normalizeLinkUrl(discord)
    if (prototype) useCaseData.prototype = normalizeLinkUrl(prototype)
    base.useCaseData = useCaseData
  } else if (input.category === 'startup') {
    const startupData: NonNullable<LaunchMetadataShape['startupData']> = {
      pitch: (input.problem ?? '').trim(),
    }
    const whitepaper = input.whitepaper?.trim()
    const deck = input.deck?.trim()
    if (whitepaper) startupData.roadmap = normalizeLaunchDocumentUri(whitepaper)
    if (discord) startupData.discord = normalizeLinkUrl(discord)
    if (deck) startupData.deck = normalizeLinkUrl(deck)
    if (input.startupComplianceAcknowledged === true) {
      const regime = input.legalFramework?.trim()
      const customNote = input.legalFrameworkNote?.trim()
      const tokenUtility = input.tokenUtility?.trim()
      const decentralization = input.decentralizationEfforts?.trim()
      const jurisdiction = input.entityJurisdiction?.trim()
      if (regime) startupData.legalFramework = regime
      if (regime === 'custom' && customNote) startupData.legalFrameworkNote = customNote
      if (tokenUtility) startupData.tokenUtility = tokenUtility
      if (decentralization) startupData.decentralizationEfforts = decentralization
      if (jurisdiction) startupData.entityJurisdiction = jurisdiction
    }
    base.startupData = startupData
    const useCaseData: NonNullable<LaunchMetadataShape['useCaseData']> = {}
    applyUseCaseTags(useCaseData, input.useCases)
    if (useCaseData.categories) base.useCaseData = useCaseData
  }

  return base
}

function applyUseCaseTags(
  target: { category?: string; categories?: string[] },
  useCases: readonly string[] | undefined,
): void {
  const slugs = useCases ?? []
  if (slugs.length === 0) return
  target.category = slugs[0]
  target.categories = [...slugs]
}
