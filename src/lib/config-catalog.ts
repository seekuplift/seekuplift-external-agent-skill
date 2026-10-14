/**
 * Config catalog — the data behind `GET /api/configs`.
 *
 * Built from the backend's `GET /api/mobile-config?cluster=mainnet-beta&
 * platform=web` (`launchConfigOptions`, `quoteAssets`, `primaryQuote`, `geo`)
 * plus the decoded on-chain DBC pool config per served `configKey`, exactly
 * as the app resolves launch options (launch-fee-options.ts + geo-access.ts).
 *
 * Caching contract (docs/plans/2026-10-14-agent-api-update.md):
 *   - `mobile-config` is fetched FRESH on every request — the backend computes
 *     `geo` per request from the forwarded caller IP and keeps it out of
 *     `version`; the geo verdict is never cached here.
 *   - The parsed option/quote-asset lists are cached ~60s keyed on the
 *     response `version` (the backend folds the served options into the
 *     version hash preimage, so changed options arrive under a new version).
 *   - The decoded on-chain config is cached per configKey (the account is
 *     immutable once created; a failed fetch is never cached).
 *
 * Nothing is hardcoded: only config keys the backend serves are listed.
 */
import { PublicKey } from '@solana/web3.js'
import { backendGetJson } from './backend.ts'
import { BACKEND_URL } from './config.ts'
import {
  extractFeeClaimer,
  fetchPoolConfigData,
  getConnection,
  readMintTokenInfo,
  SPL_TOKEN_PROGRAM_ID,
  toBigIntish,
  toFiniteNumber,
  type ScaledUiAmountConfig,
} from './dbc-shared.ts'
import { getDonationClaimAuthorities } from './config.ts'
import {
  decodeLaunchFeeShape,
  isCauseOnlyFeeConfig,
  isDonationRoutingCapable,
  launchFeeDetailLines,
  launchFeeLabel,
  type LaunchFeeShape,
} from './launch-fee-options.ts'
import {
  parseGeoVerdict,
  resolveCreateGeo,
  type GeoVerdict,
  type LaunchCategory,
} from './geo.ts'

// ─── Quote asset registry ──────────────────────────────────────────────────────
// Port of the app's src/domain/quote-assets.ts built-ins; backend-served
// `quoteAssets` entries merge over them (a served entry for a built-in mint
// may add `issuer` but can never rewrite the built-in's identity).

export type QuoteAssetRecord = {
  mint: string
  symbol: string
  decimals: number
  tokenProgram: string
  issuer: string | null
  firstBuyDefault: string | null
}

const BUILTIN_QUOTE_ASSETS: readonly QuoteAssetRecord[] = [
  {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    decimals: 9,
    tokenProgram: SPL_TOKEN_PROGRAM_ID,
    issuer: null,
    firstBuyDefault: null,
  },
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    tokenProgram: SPL_TOKEN_PROGRAM_ID,
    issuer: null,
    firstBuyDefault: null,
  },
  {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    decimals: 6,
    tokenProgram: SPL_TOKEN_PROGRAM_ID,
    issuer: null,
    firstBuyDefault: null,
  },
  {
    mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
    symbol: 'SKR',
    decimals: 6,
    tokenProgram: SPL_TOKEN_PROGRAM_ID,
    issuer: null,
    firstBuyDefault: '100',
  },
]

const BUILTIN_BY_MINT: ReadonlyMap<string, QuoteAssetRecord> = new Map(
  BUILTIN_QUOTE_ASSETS.map((asset) => [asset.mint, asset]),
)

function isBuiltinQuoteMint(mint: string | null | undefined): boolean {
  return mint != null && BUILTIN_BY_MINT.has(mint)
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asDecimals(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : null
}

/**
 * Tolerant parse of the backend `quoteAssets` list (SQ-B-1 wire shape:
 * `{ mint, symbol, decimals, tokenProgram, issuer?, firstBuyDefault? }`).
 * Entries missing a non-empty `mint`, `symbol`, `tokenProgram`, or a valid
 * `decimals` are dropped whole — a malformed entry never half-registers.
 * A served entry for a built-in mint keeps the built-in's identity.
 */
export function parseBackendQuoteAssets(raw: unknown): QuoteAssetRecord[] {
  if (!Array.isArray(raw)) return []
  const out: QuoteAssetRecord[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const mint = asNonEmptyString(rec.mint)
    const symbol = asNonEmptyString(rec.symbol)
    const decimals = asDecimals(rec.decimals)
    const tokenProgram = asNonEmptyString(rec.tokenProgram)
    if (!mint || !symbol || decimals == null || !tokenProgram) continue
    const parsed: QuoteAssetRecord = {
      mint,
      symbol,
      decimals,
      tokenProgram,
      issuer: asNonEmptyString(rec.issuer),
      firstBuyDefault:
        typeof rec.firstBuyDefault === 'string' && /\d/.test(rec.firstBuyDefault)
          ? rec.firstBuyDefault.trim()
          : null,
    }
    const builtin = BUILTIN_BY_MINT.get(mint)
    out.push(builtin ? { ...builtin, issuer: parsed.issuer ?? builtin.issuer } : parsed)
  }
  return out
}

// ─── Mobile-config wire types + parse ──────────────────────────────────────────

export type LaunchConfigOptionRef = {
  configKey: string
  optionId?: string
  quoteMint?: string
}

export type LaunchConfigOptionsByCategory = Partial<
  Record<LaunchCategory, LaunchConfigOptionRef[]>
>

export type MobileConfigResponse = {
  cluster?: string
  launchConfigKeys?: { meme?: string; idea?: string; startup?: string }
  launchConfigOptions?: { meme?: unknown; idea?: unknown; startup?: unknown }
  quoteAssets?: unknown
  primaryQuote?: unknown
  geo?: unknown
  version?: string
}

const CATEGORIES: readonly LaunchCategory[] = ['meme', 'idea', 'startup']

function parseOptionList(raw: unknown): LaunchConfigOptionRef[] {
  if (!Array.isArray(raw)) return []
  const out: LaunchConfigOptionRef[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const configKey = (entry as { configKey?: unknown }).configKey
    const optionId = (entry as { optionId?: unknown }).optionId
    const quoteMint = (entry as { quoteMint?: unknown }).quoteMint
    if (typeof configKey !== 'string' || !configKey.trim()) continue
    out.push({
      configKey: configKey.trim(),
      ...(typeof optionId === 'string' && optionId.trim()
        ? { optionId: optionId.trim() }
        : {}),
      ...(typeof quoteMint === 'string' && quoteMint.trim()
        ? { quoteMint: quoteMint.trim() }
        : {}),
    })
  }
  return out
}

/**
 * Tolerant wire parse of `launchConfigOptions`; a category whose option list
 * is absent/malformed falls back to a single `default` option carrying the
 * backend's `launchConfigKeys[category]` default — still backend-served,
 * never hardcoded.
 */
export function parseLaunchConfigOptions(
  response: MobileConfigResponse,
): LaunchConfigOptionsByCategory {
  const raw = response.launchConfigOptions ?? {}
  const out: LaunchConfigOptionsByCategory = {}
  for (const category of CATEGORIES) {
    const list = parseOptionList(raw[category])
    if (list.length > 0) {
      out[category] = list
      continue
    }
    const fallbackKey = asNonEmptyString(response.launchConfigKeys?.[category])
    if (fallbackKey) out[category] = [{ configKey: fallbackKey }]
  }
  return out
}

// ─── Fetch + caches ────────────────────────────────────────────────────────────

const OPTIONS_CACHE_TTL_MS = 60_000

type ParsedMobileConfig = {
  options: LaunchConfigOptionsByCategory
  quoteAssets: QuoteAssetRecord[]
}

/** Version-keyed parsed-options cache (~60s). See module docstring. */
let optionsCache: {
  baseUrl: string
  version: string
  expiresAt: number
  parsed: ParsedMobileConfig
} | null = null

/**
 * Decoded on-chain pool configs, cached per configKey. The account is
 * immutable once created, so successes cache permanently; failures (absent
 * account, RPC error) are never cached.
 */
const poolConfigCache = new Map<string, Record<string, unknown>>()

/** Test seam: clear both caches. */
export function resetConfigCatalogCachesForTests(): void {
  optionsCache = null
  poolConfigCache.clear()
}

/** Decoded mint facts needed when the serve record lacks them. */
export type MintTokenInfo = {
  decimals: number | null
  tokenProgram: string | null
  scaledUiAmount: ScaledUiAmountConfig | null
}

/**
 * Injectable seams — tests drive this module with captured fixtures instead
 * of network.
 */
export type CatalogDeps = {
  /** `GET /api/mobile-config?cluster=mainnet-beta&platform=web` with the
   *  caller's IP forwarded. Called on EVERY request — its `geo` is the
   *  per-caller verdict and is never cached. */
  fetchMobileConfig?: (clientIp: string | null) => Promise<MobileConfigResponse>
  /** Decoded on-chain pool config (`getPoolConfig` result, unwrapped). */
  fetchPoolConfig?: (configKey: string) => Promise<Record<string, unknown> | null>
  /** On-chain mint read for mints that may carry Token-2022 extensions or
   *  lack a serve record. */
  fetchMintInfo?: (mint: string) => Promise<MintTokenInfo>
  /** The DONATION_CLAIM_AUTHORITIES env value (parsed list). Default: env. */
  donationClaimAuthorities?: readonly string[] | null
  now?: () => number
}

async function defaultFetchMobileConfig(clientIp: string | null): Promise<MobileConfigResponse> {
  return backendGetJson<MobileConfigResponse>(
    '/api/mobile-config',
    { cluster: 'mainnet-beta', platform: 'web' },
    { clientIp },
  )
}

async function defaultFetchMintInfo(mint: string): Promise<MintTokenInfo> {
  return readMintTokenInfo(getConnection(), new PublicKey(mint))
}

async function cachedPoolConfig(
  configKey: string,
  fetchPoolConfig: NonNullable<CatalogDeps['fetchPoolConfig']>,
): Promise<Record<string, unknown> | null> {
  const cached = poolConfigCache.get(configKey)
  if (cached) return cached
  const decoded = await fetchPoolConfig(configKey)
  if (decoded) poolConfigCache.set(configKey, decoded)
  return decoded
}

// ─── Catalog entry shape ───────────────────────────────────────────────────────

export type CatalogCurveFees = {
  kind: 'flat' | 'decay' | 'custom'
  /** The opening (cliff) trading fee in bps; null when undecoded. */
  openingBps: number | null
  /** The fee the curve decays/settles to, in bps; null when undecoded. */
  floorBps: number | null
  /** `time` = linear per-period decay (duration below), `none` = flat. */
  decay: 'time' | 'none' | 'custom'
  /** Decay schedule: number of periods × period length, in the unit below. */
  decayPeriods: number | null
  decayPeriodLength: number | null
  /** `slots` (~0.4s each) or `seconds`, from the config's activationType. */
  decayUnit: 'slots' | 'seconds' | null
  /** Approximate total decay window in seconds (slots ≈ 0.4s). */
  decaySecondsEstimate: number | null
  /** Whether the curve's dynamic (volatility) fee is enabled. */
  dynamic: boolean | null
}

export type CatalogPostGradFees = {
  kind: 'flat' | 'marketCapDecay' | 'custom'
  startBps: number | null
  floorBps: number | null
  /** `marketCap` = decays toward floor as market cap grows. */
  decay: 'marketCap' | 'none' | 'custom'
}

export type CatalogEntryGeo = {
  /** True when EVERY category this config serves is create-allowed for the
   *  caller. See `byCategory` for the per-category verdicts. */
  allowed: boolean
  /** First restricted feature key when not fully allowed, else null. */
  reason: string | null
  /** The caller's resolved region, echoed by the backend; null when
   *  unresolved. */
  region: string | null
  byCategory: Partial<Record<LaunchCategory, { allowed: boolean; reason: string | null }>>
}

export type ConfigCatalogEntry = {
  configKey: string
  optionId: string | null
  /** Categories the backend offers this config under, in canonical order. */
  categories: LaunchCategory[]
  quote: {
    mint: string | null
    symbol: string | null
    decimals: number | null
    tokenProgram: string | null
    issuer: string | null
    /** Pre-fill for the launch's creator first buy, in display units. */
    firstBuyDefault: string | null
    /** The Token-2022 ScaledUiAmount multiplier in effect now, as a decimal
     *  string; null when the mint carries no such extension. */
    scaledUiAmountMultiplier: string | null
  }
  fees: {
    /** One-line human summary, chain-derived. */
    label: string
    /** Detail lines mirroring the app's launch review copy. */
    details: string[]
    curve: CatalogCurveFees
    postGraduation: CatalogPostGradFees
    /** `creatorTradingFeePercentage` — percent of trading fees routed to the
     *  creator share; null when undecoded. */
    creatorSharePct: number | null
    /** Creator share 0 AND cause-capable: every fee after Meteora's protocol
     *  cut goes to the cause. */
    allFeesToCause: boolean
  }
  /** The config's fee claimer is a configured donation claim authority
   *  (DONATION_CLAIM_AUTHORITIES). Fail closed: undecoded claimer or unset
   *  env → false. */
  supportsCause: boolean
  /** The config's `enableFirstSwapWithMinFee` flag — a creator first buy may
   *  be bundled into the launch transaction. */
  supportsFirstBuy: boolean
  /** Partner-configured pool creation fee in SOL lamports, as a decimal
   *  string; null when the config could not be decoded. */
  poolCreationFeeLamports: string | null
  /** The config's `migrationQuoteThreshold`, in raw quote atoms. */
  migrationQuoteThreshold: string | null
  /** The quote mint is a stock quote asset (served, non-built-in). */
  isStock: boolean
  /** Categories this config is the service default for — `["meme"]` on the
   *  first meme option with a creator share; never an all-fees-to-cause
   *  config. */
  defaultFor: LaunchCategory[]
  /** The caller's create-geo verdict, fresh from the backend per request. */
  geo: CatalogEntryGeo
  /** The config's on-chain account could not be fetched/decoded; fee fields
   *  then carry the conservative `custom`/null values. */
  decodeError: string | null
}

// ─── Entry build ───────────────────────────────────────────────────────────────

const SLOT_SECONDS_ESTIMATE = 0.4

function curveFeesForApi(
  shape: LaunchFeeShape['curve'],
  dynamic: boolean | null,
): CatalogCurveFees {
  if (shape.kind === 'flat') {
    return {
      kind: 'flat',
      openingBps: shape.feeBps,
      floorBps: shape.feeBps,
      decay: 'none',
      decayPeriods: null,
      decayPeriodLength: null,
      decayUnit: null,
      decaySecondsEstimate: null,
      dynamic,
    }
  }
  if (shape.kind === 'decay') {
    // The scheduler's secondFactor is expressed in the config's activation
    // unit (slots when activationType=0, seconds when 1) — carried on the
    // shape as `periodUnit`.
    const unit = shape.periodUnit
    const total = shape.periods * shape.periodLength
    return {
      kind: 'decay',
      openingBps: shape.startFeeBps,
      floorBps: shape.endFeeBps,
      decay: 'time',
      decayPeriods: shape.periods,
      decayPeriodLength: shape.periodLength,
      decayUnit: unit,
      decaySecondsEstimate:
        unit === 'seconds'
          ? total
          : unit === 'slots'
            ? Math.round(total * SLOT_SECONDS_ESTIMATE)
            : null,
      dynamic,
    }
  }
  return {
    kind: 'custom',
    openingBps: null,
    floorBps: null,
    decay: 'custom',
    decayPeriods: null,
    decayPeriodLength: null,
    decayUnit: null,
    decaySecondsEstimate: null,
    dynamic,
  }
}

function postGradFeesForApi(shape: LaunchFeeShape['postGraduation']): CatalogPostGradFees {
  if (shape.kind === 'flat') {
    return { kind: 'flat', startBps: shape.feeBps, floorBps: shape.feeBps, decay: 'none' }
  }
  if (shape.kind === 'marketCapDecay') {
    return {
      kind: 'marketCapDecay',
      startBps: shape.startFeeBps,
      floorBps: shape.endFeeBps,
      decay: 'marketCap',
    }
  }
  return { kind: 'custom', startBps: null, floorBps: null, decay: 'custom' }
}

/**
 * The raw decimal string of the ScaledUiAmount leg in effect at
 * `nowUnixSec` (`newMultiplier` at/after its effective timestamp), or null
 * when the mint carries no extension. Exact — no float round-trip.
 */
function scaledUiMultiplierString(
  config: ScaledUiAmountConfig | null,
  nowUnixSec: number,
): string | null {
  if (!config) return null
  const ts = config.newMultiplierEffectiveTimestamp
  const useNew = Number.isFinite(ts) && nowUnixSec >= ts
  return useNew ? config.newMultiplier : config.multiplier
}

export async function getConfigCatalog(
  clientIp: string | null,
  deps: CatalogDeps = {},
): Promise<{ configs: ConfigCatalogEntry[] }> {
  const { configs } = await getConfigCatalogWithGeo(clientIp, deps)
  return { configs }
}

/**
 * The config catalog plus the raw geo verdict it was built against — the
 * launch endpoint mirrors the app's per-key geo lookups (and the backend's
 * meme donation-claim refusal keys) on this same verdict, so one shared
 * mobile-config fetch keeps geo and config entries consistent.
 */
export async function getConfigCatalogWithGeo(
  clientIp: string | null,
  deps: CatalogDeps = {},
): Promise<{ configs: ConfigCatalogEntry[]; geo: GeoVerdict }> {
  const now = deps.now ?? (() => Date.now())
  const fetchMobileConfig = deps.fetchMobileConfig ?? defaultFetchMobileConfig
  const fetchPoolConfig = deps.fetchPoolConfig ?? fetchPoolConfigData
  const fetchMintInfo = deps.fetchMintInfo ?? defaultFetchMintInfo
  const donationClaimAuthorities =
    deps.donationClaimAuthorities === undefined
      ? getDonationClaimAuthorities()
      : deps.donationClaimAuthorities

  // Fresh fetch EVERY request — `geo` is per caller and never cached.
  const response = await fetchMobileConfig(clientIp)
  if (response?.cluster && response.cluster !== 'mainnet-beta') {
    throw new Error(`mobile-config returned unexpected cluster: ${response.cluster}`)
  }
  const geo: GeoVerdict = parseGeoVerdict(response?.geo)

  // Parsed options cached ~60s keyed on the response `version` (the backend
  // folds the served options into the version hash preimage, so changed
  // options always arrive under a new version).
  const version = typeof response?.version === 'string' ? response.version : ''
  let parsed: ParsedMobileConfig | null = null
  if (
    version &&
    optionsCache &&
    optionsCache.version === version &&
    optionsCache.baseUrl === BACKEND_URL &&
    optionsCache.expiresAt > now()
  ) {
    parsed = optionsCache.parsed
  }
  if (!parsed) {
    parsed = {
      options: parseLaunchConfigOptions(response),
      quoteAssets: parseBackendQuoteAssets(response?.quoteAssets),
    }
    if (version) {
      optionsCache = {
        baseUrl: BACKEND_URL,
        version,
        expiresAt: now() + OPTIONS_CACHE_TTL_MS,
        parsed,
      }
    }
  }

  // Merge categories per config key, preserving canonical category order and
  // first-seen option order.
  const merged = new Map<
    string,
    { optionId?: string; optionMint?: string; categories: LaunchCategory[] }
  >()
  const memeOrder: string[] = []
  for (const category of CATEGORIES) {
    for (const ref of parsed.options[category] ?? []) {
      let entry = merged.get(ref.configKey)
      if (!entry) {
        entry = { categories: [] }
        merged.set(ref.configKey, entry)
      }
      if (!entry.categories.includes(category)) entry.categories.push(category)
      entry.optionId ??= ref.optionId
      entry.optionMint ??= ref.quoteMint
      if (category === 'meme') memeOrder.push(ref.configKey)
    }
  }

  // Resolve each unique config's on-chain decode (cached per key; failures
  // degrade the entry, never the whole catalog).
  const mintInfoCache = new Map<string, Promise<MintTokenInfo>>()
  const mintInfo = (mint: string): Promise<MintTokenInfo> => {
    let pending = mintInfoCache.get(mint)
    if (!pending) {
      pending = fetchMintInfo(mint)
      mintInfoCache.set(mint, pending)
    }
    return pending
  }

  const entries: ConfigCatalogEntry[] = []
  for (const [configKey, meta] of merged) {
    let decoded: Record<string, unknown> | null = null
    let decodeError: string | null = null
    try {
      decoded = await cachedPoolConfig(configKey, fetchPoolConfig)
      if (!decoded) decodeError = 'pool config account not found or undecodable'
    } catch (err) {
      decodeError = err instanceof Error ? err.message : String(err)
    }

    const quoteMint =
      (decoded?.quoteMint != null ? String(decoded.quoteMint) : null) ?? meta.optionMint ?? null
    const served = quoteMint ? parsed.quoteAssets.find((a) => a.mint === quoteMint) : undefined
    const builtin = quoteMint ? BUILTIN_BY_MINT.get(quoteMint) : undefined
    const record = served ?? builtin ?? null
    const isStock = !!served && !isBuiltinQuoteMint(quoteMint)

    // Resolve mint facts we cannot take from a record: Token-2022 mints may
    // carry the ScaledUiAmount extension; unregistered mints need an
    // on-chain read for decimals/program.
    let mintInfoResult: MintTokenInfo | null = null
    if (quoteMint && (!record || record.tokenProgram !== SPL_TOKEN_PROGRAM_ID)) {
      try {
        mintInfoResult = await mintInfo(quoteMint)
      } catch {
        mintInfoResult = null
      }
      // SQ-APP-4 parity (app resolveQuoteAssetForLaunch, dbc-launch-client.ts):
      // a failed or decimal-less read cannot prove the mint is unscaled — fail
      // closed rather than silently converting a display-units first buy with
      // multiplier 1 on a mint that may carry ScaledUiAmount.
      if (mintInfoResult == null || mintInfoResult.decimals == null) {
        decodeError ??= `Unable to resolve mint info for quote mint ${quoteMint}`
      }
    }

    const shape = decoded ? decodeLaunchFeeShape(decoded) : null
    const feeClaimer = decoded ? extractFeeClaimer(decoded) : null
    const supportsCause = isDonationRoutingCapable(feeClaimer, donationClaimAuthorities)
    const allFeesToCause = isCauseOnlyFeeConfig(shape, supportsCause)
    const creatorSharePct = shape?.creatorTradingFeePercentage ?? null

    const byCategory: CatalogEntryGeo['byCategory'] = {}
    let allAllowed = true
    let firstReason: string | null = null
    for (const category of meta.categories) {
      const verdict = resolveCreateGeo(geo, category, isStock)
      byCategory[category] = { allowed: verdict.allowed, reason: verdict.reason }
      if (!verdict.allowed) {
        allAllowed = false
        firstReason ??= verdict.reason
      }
    }

    entries.push({
      configKey,
      optionId: meta.optionId ?? null,
      categories: meta.categories,
      quote: {
        mint: quoteMint,
        symbol:
          record?.symbol ??
          (quoteMint ? `${quoteMint.slice(0, 4)}…${quoteMint.slice(-4)}` : null),
        decimals: record?.decimals ?? mintInfoResult?.decimals ?? null,
        tokenProgram: record?.tokenProgram ?? mintInfoResult?.tokenProgram ?? null,
        issuer: record?.issuer ?? null,
        firstBuyDefault: record?.firstBuyDefault ?? null,
        scaledUiAmountMultiplier: scaledUiMultiplierString(
          mintInfoResult?.scaledUiAmount ?? null,
          Math.floor(now() / 1000),
        ),
      },
      fees: {
        label: launchFeeLabel(shape, allFeesToCause),
        details: launchFeeDetailLines(shape, allFeesToCause),
        curve: curveFeesForApi(
          shape?.curve ?? { kind: 'custom' },
          shape?.curveDynamicFee ?? null,
        ),
        postGraduation: postGradFeesForApi(shape?.postGraduation ?? { kind: 'custom' }),
        creatorSharePct,
        allFeesToCause,
      },
      supportsCause,
      supportsFirstBuy: decoded ? !!toFiniteNumber(decoded.enableFirstSwapWithMinFee) : false,
      poolCreationFeeLamports: toBigIntish(decoded?.poolCreationFee)?.toString() ?? null,
      migrationQuoteThreshold: toBigIntish(decoded?.migrationQuoteThreshold)?.toString() ?? null,
      isStock,
      defaultFor: [],
      geo: {
        allowed: allAllowed,
        reason: firstReason,
        region: geo.region,
        byCategory,
      },
      decodeError,
    })
  }

  // Memecoin default: the first option in the backend's meme list with a
  // creator share > 0 — never an all-fees-to-cause config.
  for (const configKey of memeOrder) {
    const entry = entries.find((candidate) => candidate.configKey === configKey)
    if (entry && entry.fees.creatorSharePct != null && entry.fees.creatorSharePct > 0) {
      entry.defaultFor = ['meme']
      break
    }
  }

  return { configs: entries, geo }
}
