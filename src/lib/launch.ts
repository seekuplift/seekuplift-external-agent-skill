/**
 * `POST /api/launch` orchestration — the agent-chosen-config launch flow.
 *
 * Validation order (refusals cost no upload budget — geo runs BEFORE any
 * backend upload, mirroring the backend's own `/api/upload/metadata` gate):
 *   1. request shape + identity limits + `image`/`imageUrl` exclusivity;
 *   2. catalog lookup — unknown `configKey`, category/config mismatch;
 *   3. donation pick (meme-only, cause-capable only, required when causes
 *      are offered) and `ideaFunding` (idea-only);
 *   4. geo pre-check on the shared verdict — `<category>.create` (meme →
 *      `cause.marketing` then the claim-kind hidden key, exactly as the
 *      backend classifies the claim), plus `stock.create` for stock-quoted
 *      configs (which the backend upload route does not check);
 *   5. image upload → metadata upload through the backend proxy;
 *   6. `buildLaunchTx` — unsigned-by-payer, mint-partial-signed.
 */
import { PublicKey } from '@solana/web3.js'
import { backendGetJson, backendPostJson } from './backend.ts'
import {
  getConfigCatalogWithGeo,
  type CatalogDeps,
  type ConfigCatalogEntry,
} from './config-catalog.ts'
import {
  geoBlockedMessage,
  regionDisplayName,
  resolveCreateGeo,
  type GeoVerdict,
  type LaunchCategory,
} from './geo.ts'
import {
  buildDonationFundingClaim,
  buildIdeaFundingClaim,
  buildLaunchMetadata,
  canonicalizeLaunchIdentity,
  causeFundingLaunchModes,
  classifyUploadClaimKind,
  ideaFundingLaunchModes,
  launchIdentityError,
  normalizeDonationProjectId,
  normalizeUseCaseSlugs,
  useCaseSlugsInCatalog,
  type CauseFundingModesResponse,
  type DonationFundingClaim,
  type IdeaFundingModesResponse,
  type LaunchMetadataShape,
} from './launch-metadata.ts'
import { buildLaunchTx, type BuildLaunchTxDeps, type LaunchTxResult } from './dbc-launch.ts'
import {
  decodeBase64Image,
  uploadImageBytes,
  uploadMetadataJson,
  type DecodedLaunchImage,
  type UploadResult,
} from './upload.ts'
import { fetchRemoteImage, ImageFetchError } from './image-fetch.ts'
import { U64_MAX, isZeroAmountInput, parseFirstBuyAtoms, parseFirstBuyUiAmount } from './first-buy.ts'
import { parseScaledUiMultiplier } from './dbc-shared.ts'

/** A refusal with an HTTP status and optional structured error fields. */
export class LaunchError extends Error {
  readonly status: number
  readonly fields: Record<string, unknown>
  constructor(
    message: string,
    status = 400,
    fields: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'LaunchError'
    this.status = status
    this.fields = fields
  }
}

/** The geo refusal — mirrors the backend's `geo_restricted` error body. */
export class GeoRestrictedError extends LaunchError {
  constructor(region: string | null, feature: string) {
    super('geo_restricted', 403, {
      error: 'geo_restricted',
      region,
      regionName: regionDisplayName(region),
      feature,
      message: geoBlockedMessage(region),
    })
  }
}

/** `GET /api/causes` item (`ImpactCause` — camelCase on the wire). */
export type BackendCause = {
  slug?: string
  label?: string
  icon?: string | null
  eligibleMemberCount?: number
  /** `shipping` | `paused` (serde lowercase). */
  status?: string
}

/** Resolved Reddit handle identity from `POST /api/idea-funding/resolve-handle`. */
export type ResolvedRedditHandle = {
  platformUserId?: string
  handle?: string
}

/**
 * Injectable seams — tests substitute captured-fixture fetches and stub
 * uploads/builds; production defaults call the real backend + SDK.
 */
export type LaunchDeps = {
  /** Config catalog + the raw geo verdict it was built against. */
  loadCatalog?: (
    clientIp: string | null,
  ) => Promise<{ configs: ConfigCatalogEntry[]; geo: GeoVerdict }>
  /** `GET /api/causes` — the cause picker's live list. */
  fetchCauses?: (clientIp: string | null) => Promise<BackendCause[]>
  /** `GET /api/cause-funding/modes`. */
  fetchCauseModes?: (clientIp: string | null) => Promise<CauseFundingModesResponse>
  /** `GET /api/idea-funding/modes`. */
  fetchIdeaModes?: (clientIp: string | null) => Promise<IdeaFundingModesResponse>
  /** `POST /api/idea-funding/resolve-handle` — handle → `t2_` lock. */
  resolveRedditHandle?: (
    handle: string,
    clientIp: string | null,
  ) => Promise<ResolvedRedditHandle>
  /** Fetch a remote `imageUrl` through the SSRF guard (Ticket 03). */
  fetchImage?: (url: string) => Promise<DecodedLaunchImage>
  /** `POST /api/upload/image` through the backend proxy. */
  uploadImage?: (
    image: ReturnType<typeof decodeBase64Image>,
    clientIp: string | null,
  ) => Promise<UploadResult>
  /** `POST /api/upload/metadata` through the backend proxy. */
  uploadMetadata?: (
    metadata: Record<string, unknown>,
    clientIp: string | null,
  ) => Promise<UploadResult>
  /** The SDK build. */
  buildTx?: (params: Parameters<typeof buildLaunchTx>[0]) => Promise<LaunchTxResult>
  /** Passthrough to `buildLaunchTx`'s own deps (connection/client). */
  buildTxDeps?: BuildLaunchTxDeps
  /** Extra deps forwarded to the default catalog loader. */
  catalogDeps?: CatalogDeps
}

const CATEGORIES: readonly LaunchCategory[] = ['meme', 'idea', 'startup']

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** `GET /api/causes` serves `{ causes: [...] }`; anything else is a failed read. */
export function parseCausesResponse(body: unknown): BackendCause[] {
  const causes = (body as { causes?: unknown } | null)?.causes
  if (!Array.isArray(causes)) throw new Error('/api/causes: expected { causes: [...] }')
  return causes as BackendCause[]
}

async function defaultFetchCauses(clientIp: string | null): Promise<BackendCause[]> {
  return parseCausesResponse(await backendGetJson<unknown>('/api/causes', {}, { clientIp }))
}

async function defaultFetchCauseModes(
  clientIp: string | null,
): Promise<CauseFundingModesResponse> {
  return backendGetJson<CauseFundingModesResponse>('/api/cause-funding/modes', {}, { clientIp })
}

async function defaultFetchIdeaModes(
  clientIp: string | null,
): Promise<IdeaFundingModesResponse> {
  return backendGetJson<IdeaFundingModesResponse>('/api/idea-funding/modes', {}, { clientIp })
}

async function defaultResolveRedditHandle(
  handle: string,
  clientIp: string | null,
): Promise<ResolvedRedditHandle> {
  return backendPostJson<ResolvedRedditHandle>(
    '/api/idea-funding/resolve-handle',
    { handle },
    { clientIp },
  )
}

/** The cause slugs the picker offers — active, SHIPPING causes only. */
function shippingCauseSlugs(causes: BackendCause[]): string[] {
  return causes
    .filter(
      (cause) => typeof cause.slug === 'string' && cause.slug.trim() && cause.status === 'shipping',
    )
    .map((cause) => cause.slug!.trim())
}

/** The request `donation` object, normalized. */
export type DonationInput = {
  mode: string
  cause?: string
  project?: string
  handle?: string
  redditUserId?: string
}

function parseDonationInput(raw: unknown): DonationInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LaunchError('donation must be an object: { mode, cause?, project?, handle?, redditUserId? }')
  }
  const rec = raw as Record<string, unknown>
  const mode = asTrimmedString(rec.mode)
  if (!mode) throw new LaunchError('donation.mode is required')
  return {
    mode,
    cause: asTrimmedString(rec.cause) ?? undefined,
    project: asTrimmedString(rec.project) ?? undefined,
    handle: asTrimmedString(rec.handle) ?? undefined,
    redditUserId: asTrimmedString(rec.redditUserId) ?? undefined,
  }
}

/** The request `ideaFunding` object, normalized. */
export type IdeaFundingInput = {
  mode: string
  address?: string
  handle?: string
  redditUserId?: string
}

function parseIdeaFundingInput(raw: unknown): IdeaFundingInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LaunchError(
      'ideaFunding must be an object: { mode, address?, handle?, redditUserId? }',
    )
  }
  const rec = raw as Record<string, unknown>
  const mode = asTrimmedString(rec.mode)
  if (!mode) throw new LaunchError('ideaFunding.mode is required')
  return {
    mode,
    address: asTrimmedString(rec.address) ?? undefined,
    handle: asTrimmedString(rec.handle) ?? undefined,
    redditUserId: asTrimmedString(rec.redditUserId) ?? undefined,
  }
}

export type PreparedLaunch = LaunchTxResult & {
  metadataUrl: string
  imageUrl: string
  configKey: string
  category: LaunchCategory
  quoteMint: string
  firstBuyAtoms: string | null
  metadata: LaunchMetadataShape
}

export async function prepareLaunch(
  rawBody: unknown,
  clientIp: string | null,
  deps: LaunchDeps = {},
): Promise<PreparedLaunch> {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new LaunchError('Request body must be a JSON object')
  }
  const body = rawBody as Record<string, unknown>

  // ── 1. request shape ────────────────────────────────────────────────────
  let imageUrlInput: string | null = null
  if (body.imageUrl != null) {
    imageUrlInput = asTrimmedString(body.imageUrl)
    if (!imageUrlInput) throw new LaunchError('imageUrl must be a non-empty string')
  }
  if (imageUrlInput && body.image != null) {
    throw new LaunchError('pass only one of `image` (base64) or `imageUrl` (a public http(s) URL)')
  }
  const configKey = asTrimmedString(body.configKey)
  if (!configKey) throw new LaunchError('Missing required field: configKey')
  const categoryRaw = asTrimmedString(body.category)
  if (!categoryRaw || !(CATEGORIES as readonly string[]).includes(categoryRaw)) {
    throw new LaunchError('category must be one of: meme, idea, startup')
  }
  const category = categoryRaw as LaunchCategory
  const payerAddress = asTrimmedString(body.payerPublicKey)
  if (!payerAddress) throw new LaunchError('Missing required field: payerPublicKey')
  try {
    new PublicKey(payerAddress)
  } catch {
    throw new LaunchError('payerPublicKey is not a valid Solana address')
  }

  const identity = canonicalizeLaunchIdentity({
    name: typeof body.name === 'string' ? body.name : '',
    symbol: typeof body.symbol === 'string' ? body.symbol : '',
    description: typeof body.description === 'string' ? body.description : '',
  })
  for (const field of ['name', 'symbol', 'description'] as const) {
    const err = launchIdentityError(field, identity[field])
    if (err) throw new LaunchError(err)
  }

  // Decode + sniff a base64 `image` BEFORE any network call — cheap local
  // checks first. An `imageUrl` is fetched later (after the geo pre-check,
  // right before the upload) through the SSRF-safe fetcher.
  let image: DecodedLaunchImage | null = null
  if (body.image != null) {
    try {
      image = decodeBase64Image(body.image)
    } catch (err) {
      throw new LaunchError(err instanceof Error ? err.message : String(err))
    }
  } else if (!imageUrlInput) {
    throw new LaunchError('image is required — pass base64 `image` or a public `imageUrl`')
  }

  // ── 2. catalog: configKey must be a served option for the category ─────
  const loadCatalog =
    deps.loadCatalog ??
    ((ip: string | null) => getConfigCatalogWithGeo(ip, deps.catalogDeps))
  const { configs, geo } = await loadCatalog(clientIp)
  const entry = configs.find((candidate) => candidate.configKey === configKey)
  if (!entry) {
    throw new LaunchError(
      `Unknown configKey: ${configKey}. List live options with GET /api/configs.`,
    )
  }
  if (!entry.categories.includes(category)) {
    throw new LaunchError(
      `configKey ${configKey} is not offered for category "${category}" (serves: ${entry.categories.join(', ') || 'none'})`,
    )
  }
  if (entry.decodeError) {
    throw new LaunchError(
      `Config ${configKey} could not be decoded: ${entry.decodeError}`,
      502,
    )
  }
  const quoteMint = entry.quote.mint
  if (!quoteMint) {
    throw new LaunchError(`Config ${configKey} has no resolvable quote mint`, 502)
  }

  // ── 3. donation pick + idea funding ─────────────────────────────────────
  // Donation is meme-only and only on cause-capable configs; `ideaFunding`
  // is idea-only.
  const donationRaw = body.donation
  const ideaFundingRaw = body.ideaFunding
  if (category !== 'meme' && donationRaw != null) {
    throw new LaunchError(`donation is only valid for meme launches (category "${category}")`)
  }
  if (donationRaw != null && !entry.supportsCause) {
    throw new LaunchError(`donation is not valid on config ${configKey} — it is not cause-capable`)
  }
  if (ideaFundingRaw != null && category !== 'idea') {
    throw new LaunchError(`ideaFunding is only valid for idea launches (category "${category}")`)
  }

  let shippingCauses: string[] | null = null
  if (category === 'meme' && entry.supportsCause) {
    const fetchCauses = deps.fetchCauses ?? defaultFetchCauses
    try {
      shippingCauses = shippingCauseSlugs(await fetchCauses(clientIp))
    } catch (err) {
      // Causes unavailable: with a donation we proceed (backend validates the
      // pick); without one we fail closed (503) since the donation-required
      // rule cannot be checked and the backend would default to managed.
      console.warn('[launch] /api/causes fetch failed', err instanceof Error ? err.message : String(err))
      if (donationRaw == null) {
        throw new LaunchError('Causes list unavailable — retry shortly', 503, {
          error: 'causes_unavailable',
        })
      }
      shippingCauses = null
    }
    if (donationRaw == null && shippingCauses != null && shippingCauses.length > 0) {
      throw new LaunchError(
        `donation is required for meme launches on cause-capable config ${configKey} — causes are offered: ${shippingCauses.join(', ')}`,
        400,
        { error: 'donation_required', causesOffered: shippingCauses },
      )
    }
  }

  let donationClaim:
    | {
        donationCause?: string
        donationProject?: string
        donationFunding?: DonationFundingClaim
      }
    | undefined
  if (category === 'meme' && donationRaw != null) {
    const donation = parseDonationInput(donationRaw)
    const fetchCauseModes = deps.fetchCauseModes ?? defaultFetchCauseModes
    let launchModes: string[]
    try {
      launchModes = causeFundingLaunchModes((await fetchCauseModes(clientIp))?.modes)
    } catch {
      launchModes = causeFundingLaunchModes(null) // registry unreachable → fallback triple
    }
    if (!launchModes.includes(donation.mode)) {
      throw new LaunchError(
        `donation.mode "${donation.mode}" is not selectable at launch (allowed: ${launchModes.join(', ')})`,
      )
    }
    if (donation.mode === 'cause') {
      const slug = donation.cause
      if (!slug) throw new LaunchError('donation.cause is required for mode "cause"')
      // The picker's whitelist applies only when the list was fetchable.
      if (shippingCauses != null && !shippingCauses.includes(slug)) {
        throw new LaunchError(
          `donation.cause "${slug}" is not a shipping cause (offered: ${shippingCauses.join(', ') || 'none'})`,
        )
      }
      donationClaim = { donationCause: slug }
    } else if (donation.mode === 'project') {
      const project = normalizeDonationProjectId(donation.project)
      if (!project) {
        throw new LaunchError(
          'donation.project must be a bare positive Giveth project id (digits only)',
        )
      }
      donationClaim = { donationProject: project }
    } else {
      const funding = buildDonationFundingClaim(donation.mode, {
        handle: donation.handle,
        redditUserId: donation.redditUserId,
      })
      if (!funding) {
        throw new LaunchError(
          `donation mode "${donation.mode}" needs valid params (x: handle; reddit: handle + redditUserId)`,
        )
      }
      donationClaim = { donationFunding: funding }
    }
  }

  let ideaFundingClaim: ReturnType<typeof buildIdeaFundingClaim> | undefined
  if (category === 'idea' && ideaFundingRaw != null) {
    const ideaFunding = parseIdeaFundingInput(ideaFundingRaw)
    const fetchIdeaModes = deps.fetchIdeaModes ?? defaultFetchIdeaModes
    let launchModes: string[]
    try {
      launchModes = ideaFundingLaunchModes((await fetchIdeaModes(clientIp))?.modes)
    } catch {
      launchModes = ideaFundingLaunchModes(null)
    }
    if (!launchModes.includes(ideaFunding.mode)) {
      throw new LaunchError(
        `ideaFunding.mode "${ideaFunding.mode}" is not selectable at launch (allowed: ${launchModes.join(', ')})`,
      )
    }
    // `direct` names a NEW recipient — the address must be on-curve (the
    // coin's entitled ed25519 signer); a PDA can never satisfy it.
    if (ideaFunding.mode === 'direct' && ideaFunding.address) {
      try {
        if (!PublicKey.isOnCurve(new PublicKey(ideaFunding.address).toBytes())) {
          throw new LaunchError(
            'ideaFunding.address must be an on-curve ed25519 address (a PDA cannot sign)',
          )
        }
      } catch (err) {
        if (err instanceof LaunchError) throw err
        throw new LaunchError('ideaFunding.address is not a valid Solana address')
      }
    }
    let redditUserId = ideaFunding.redditUserId
    if (ideaFunding.mode === 'reddit' && !redditUserId && ideaFunding.handle) {
      const resolve = deps.resolveRedditHandle ?? defaultResolveRedditHandle
      try {
        const resolved = await resolve(ideaFunding.handle, clientIp)
        redditUserId = resolved.platformUserId ?? undefined
      } catch {
        throw new LaunchError(
          'ideaFunding.mode "reddit" could not resolve the handle — pass redditUserId (the t2_ id) explicitly',
          502,
        )
      }
      if (!redditUserId) {
        throw new LaunchError(
          'ideaFunding.mode "reddit" needs a resolvable handle or an explicit redditUserId (t2_ id)',
        )
      }
    }
    ideaFundingClaim = buildIdeaFundingClaim(ideaFunding.mode, {
      address: ideaFunding.address,
      handle: ideaFunding.handle,
      redditUserId,
    })
    if (ideaFundingClaim == null) {
      throw new LaunchError(
        `ideaFunding mode "${ideaFunding.mode}" needs valid params (direct: address; x: handle; reddit: handle + redditUserId)`,
      )
    }
  }

  // ── 3b. idea/startup required fields ────────────────────────────────────
  const useCases =
    category === 'idea' || category === 'startup'
      ? useCaseSlugsInCatalog(normalizeUseCaseSlugs(body.useCases ?? body.useCase), category)
      : []
  const problem = asTrimmedString(body.problem)
  if ((category === 'idea' || category === 'startup') && !problem) {
    throw new LaunchError(
      category === 'idea'
        ? 'problem is required for idea launches (the use-case statement)'
        : 'problem is required for startup launches (the pitch)',
    )
  }
  if ((category === 'idea' || category === 'startup') && useCases.length === 0) {
    throw new LaunchError(
      `useCases is required for ${category} launches — 1–3 slugs from the ${category} catalog`,
    )
  }
  if (category === 'idea' && !asTrimmedString(body.prototype)) {
    throw new LaunchError('prototype is required for idea launches')
  }
  if (category === 'startup' && !asTrimmedString(body.deck)) {
    throw new LaunchError('deck is required for startup launches')
  }

  // ── 4. geo pre-check — BEFORE any upload, so a refusal consumes no
  //       upload budget. Mirrors the backend's /api/upload/metadata gate.
  const createVerdict = resolveCreateGeo(geo, category, entry.isStock)
  if (!createVerdict.allowed) {
    throw new GeoRestrictedError(createVerdict.region, createVerdict.reason ?? 'unknown')
  }
  if (category === 'meme') {
    // cause.marketing was already checked by resolveCreateGeo; here the
    // claim-kind hidden key the backend derives from the claim itself.
    const claimDoc: Record<string, unknown> = donationClaim
      ? { ...donationClaim }
      : {}
    const kind = classifyUploadClaimKind(claimDoc)
    const hiddenKey =
      kind === 'specific' ? 'cause.specific_hidden' : 'cause.managed_hidden'
    if (geo?.restricted.includes(hiddenKey as never)) {
      throw new GeoRestrictedError(geo.region, hiddenKey)
    }
  }

  // ── 5. first buy — only on configs whose enableFirstSwapWithMinFee is set.
  const hasFirstBuyInput = body.firstBuyAtoms != null || body.firstBuyAmount != null
  if (hasFirstBuyInput && !entry.supportsFirstBuy) {
    throw new LaunchError(
      `config ${configKey} does not support a creator first buy (enableFirstSwapWithMinFee is unset)`,
    )
  }
  let firstBuyAtoms: bigint | undefined
  if (hasFirstBuyInput) {
    if (body.firstBuyAtoms != null && body.firstBuyAmount != null) {
      throw new LaunchError('pass only one of firstBuyAtoms (raw atoms) or firstBuyAmount (display units)')
    }
    const quoteDecimals = entry.quote.decimals
    if (quoteDecimals == null) {
      throw new LaunchError(`Config ${configKey} quote decimals are unknown — cannot convert first buy`, 502)
    }
    if (body.firstBuyAtoms != null) {
      const atoms = parseFirstBuyAtoms(body.firstBuyAtoms)
      if (atoms == null) {
        throw new LaunchError('firstBuyAtoms must be a bare unsigned integer string of raw quote atoms (a JSON number must be a safe integer — pass large values as a string)')
      }
      firstBuyAtoms = atoms
    } else {
      const amount = body.firstBuyAmount
      if (typeof amount !== 'string' && typeof amount !== 'number') {
        throw new LaunchError('firstBuyAmount must be a display-units decimal string')
      }
      const multiplier = parseScaledUiMultiplier(entry.quote.scaledUiAmountMultiplier)
      if (entry.quote.scaledUiAmountMultiplier != null && !multiplier) {
        // Extension present but multiplier unreadable: never fall back to 1.
        throw new LaunchError(
          `Config ${configKey} quote mint scaled-UI multiplier is undecodable — cannot convert firstBuyAmount`,
          502,
        )
      }
      const atoms = parseFirstBuyUiAmount(String(amount), quoteDecimals, multiplier)
      if (atoms == null) {
        throw new LaunchError(
          `firstBuyAmount "${String(amount)}" is not a valid non-negative decimal (≤ ${quoteDecimals} fraction digits)`,
        )
      }
      firstBuyAtoms = atoms
    }
    if (firstBuyAtoms > U64_MAX) {
      throw new LaunchError('first buy exceeds the maximum u64 atom amount (18446744073709551615)')
    }
    // An explicit zero (SKILL.md: "0/omitted = no first buy") means no first
    // buy; a non-zero request that floors to 0 atoms is rejected (app: "tooSmall").
    if (firstBuyAtoms <= 0n) {
      if (body.firstBuyAmount != null && !isZeroAmountInput(body.firstBuyAmount)) {
        throw new LaunchError(
          'first buy rounds to 0 atoms (amount too small for the quote mint decimals/multiplier)',
        )
      }
      firstBuyAtoms = undefined
    }
  }

  // ── 6. uploads through the backend proxy (image first — its URL is a
  //       metadata field) — geo verdict already passed.
  if (image == null) {
    // `imageUrl`: fetch through the SSRF guard (vet → pin → manual
    // redirects → size cap → magic-byte sniff) before re-uploading.
    const fetchImage = deps.fetchImage ?? fetchRemoteImage
    try {
      image = await fetchImage(imageUrlInput!)
    } catch (err) {
      if (err instanceof ImageFetchError) {
        throw new LaunchError(err.message, err.status)
      }
      throw new LaunchError(
        `imageUrl could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
        502,
      )
    }
  }
  const uploadImage = deps.uploadImage ?? uploadImageBytes
  const uploadMetadata = deps.uploadMetadata ?? uploadMetadataJson
  const imageResult = await uploadImage(image, clientIp)

  const metadata = buildLaunchMetadata({
    name: identity.name,
    symbol: identity.symbol,
    description: identity.description,
    imageUrl: imageResult.url,
    category,
    creatorAddress: payerAddress,
    website: asTrimmedString(body.website) ?? undefined,
    twitter: asTrimmedString(body.twitter) ?? undefined,
    telegram: asTrimmedString(body.telegram) ?? undefined,
    discord: asTrimmedString(body.discord) ?? undefined,
    useCases,
    problem: problem ?? undefined,
    whitepaper: asTrimmedString(body.whitepaper) ?? undefined,
    prototype: asTrimmedString(body.prototype) ?? undefined,
    deck: asTrimmedString(body.deck) ?? undefined,
    legalFramework: asTrimmedString(body.legalFramework) ?? undefined,
    legalFrameworkNote: asTrimmedString(body.legalFrameworkNote) ?? undefined,
    tokenUtility: asTrimmedString(body.tokenUtility) ?? undefined,
    decentralizationEfforts: asTrimmedString(body.decentralizationEfforts) ?? undefined,
    entityJurisdiction: asTrimmedString(body.entityJurisdiction) ?? undefined,
    startupComplianceAcknowledged: body.startupComplianceAcknowledged === true,
    donationClaim,
    ideaFundingClaim: ideaFundingClaim ?? null,
  })
  const metadataResult = await uploadMetadata(metadata as unknown as Record<string, unknown>, clientIp)

  // ── 7. transaction build ────────────────────────────────────────────────
  const buildTx = deps.buildTx ?? ((p: Parameters<typeof buildLaunchTx>[0]) => buildLaunchTx(p, deps.buildTxDeps))
  const tx = await buildTx({
    name: identity.name,
    symbol: identity.symbol,
    metadataUrl: metadataResult.url,
    payerAddress,
    configKey,
    quoteMint,
    firstBuyAtoms,
  })

  return {
    ...tx,
    metadataUrl: metadataResult.url,
    imageUrl: imageResult.url,
    configKey,
    category,
    quoteMint,
    firstBuyAtoms: firstBuyAtoms != null && firstBuyAtoms > 0n ? firstBuyAtoms.toString() : null,
    metadata,
  }
}
