/**
 * POST /api/launch orchestration tests — rejection rules, claim/metadata
 * serialization, geo-before-upload ordering, and first-buy conversion.
 *
 * Catalog data comes from the REAL captured fixtures (production
 * mobile-config + real on-chain getAccountInfo decodes through the SDK);
 * backend upload/build seams are stubs that record whether they ran, so
 * refusal tests can assert no upload was attempted. Where a scenario needs a
 * config shape no fixture carries (a non-capable claimer, a stock quote
 * mint), the real decoded fixture is patched at the field level — never a
 * fabricated account.
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { DynamicBondingCurveClient, getCurrentPoint } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  getConfigCatalogWithGeo,
  resetConfigCatalogCachesForTests,
  type CatalogDeps,
  type ConfigCatalogEntry,
  type MobileConfigResponse,
} from '../src/lib/config-catalog.ts'
import {
  buildLaunchMetadata,
  classifyUploadClaimKind,
  normalizeUseCaseSlugs,
  useCaseSlugsInCatalog,
  buildDonationFundingClaim,
  buildIdeaFundingClaim,
  causeFundingLaunchModes,
  ideaFundingLaunchModes,
} from '../src/lib/launch-metadata.ts'
import {
  canonicalFirstBuyAmount,
  parseFirstBuyUiAmount,
} from '../src/lib/first-buy.ts'
import {
  prepareLaunch,
  parseCausesResponse,
  LaunchError,
  GeoRestrictedError,
  type BackendCause,
  type LaunchDeps,
} from '../src/lib/launch.ts'
import { OPEN_GEO_VERDICT } from '../src/lib/geo.ts'
import { toBN, unwrapConfig } from '../src/lib/dbc-shared.ts'
import { ImageFetchError } from '../src/lib/image-fetch.ts'
import { DBC_PROGRAM_ID, NATIVE_MINT } from '../src/lib/config.ts'
import {
  decodePoolConfigFixture,
  loadFixture,
  mobileConfigFixture,
  DONATION_CLAIM_AUTHORITY,
  LEGACY_CONFIG_ACCOUNT,
  LEGACY_CONFIG_KEY,
  LIVE_CONFIG_ACCOUNT,
  LIVE_CONFIG_KEY,
} from './helpers.ts'

const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
/** A made-up stock quote mint (never fetched — mint info is stubbed). */
const STOCK_MINT = 'ST0cKm1ntFakeStockMint11111111111111111111'
const STOCK_CONFIG_KEY = '5t0cKc0nf1gFakeStockConfig1111111111111111111'

/** A 1×1 transparent PNG. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const PAYER = DONATION_CLAIM_AUTHORITY // any valid base58 key works
/** A valid base58 key that is NOT the donation claim authority — used to
 *  render a config non-cause-capable in the extraPoolConfigs patcher. */
const NON_AUTHORITY_CLAIMER = 'So11111111111111111111111111111111111111112'

// ─── Fixture-backed catalog seams ─────────────────────────────────────────────

type CatalogScenario = {
  /** Overrides merged over the captured mobile-config fixture. */
  mobileConfig?: Partial<MobileConfigResponse>
  /** Extra (configKey → patched decode) entries layered over the fixtures. */
  extraPoolConfigs?: Record<string, (decoded: Record<string, unknown>) => Record<string, unknown>>
  mintInfo?: CatalogDeps['fetchMintInfo']
  donationClaimAuthorities?: string[] | null
}

async function catalogDeps(scenario: CatalogScenario = {}): Promise<CatalogDeps> {
  const live = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
  const legacy = await decodePoolConfigFixture(LEGACY_CONFIG_ACCOUNT)
  const base: Record<string, Record<string, unknown> | null> = {
    [LIVE_CONFIG_KEY]: live,
    [LEGACY_CONFIG_KEY]: legacy,
  }
  for (const [key, patch] of Object.entries(scenario.extraPoolConfigs ?? {})) {
    base[key] = patch(base[key] ?? live!)
  }
  return {
    fetchMobileConfig: async () => mobileConfigFixture(scenario.mobileConfig),
    fetchPoolConfig: async (key) => base[key] ?? null,
    fetchMintInfo:
      scenario.mintInfo ??
      (async (mint) => ({
        // The quote mint is always read on-chain — answer per mint (wSOL 9).
        decimals: mint === NATIVE_MINT ? 9 : 6,
        tokenProgram: SPL_TOKEN_PROGRAM,
        scaledUiAmount: null,
      })),
    donationClaimAuthorities:
      scenario.donationClaimAuthorities === undefined
        ? [DONATION_CLAIM_AUTHORITY]
        : scenario.donationClaimAuthorities,
  }
}

/** Add a served option to the fixture's launchConfigOptions. */
function serveOption(
  category: 'meme' | 'idea' | 'startup',
  ref: { configKey: string; optionId?: string; quoteMint?: string },
): Partial<MobileConfigResponse> {
  const fixture = mobileConfigFixture()
  return {
    launchConfigOptions: {
      ...(fixture.launchConfigOptions as object),
      [category]: [
        ...((fixture.launchConfigOptions?.[category] as unknown[]) ?? []),
        ref,
      ],
    },
  }
}

// ─── Recording stubs for the network seams ────────────────────────────────────

type CallLog = { imageUploads: number; metadataUploads: number; builds: number; lastTx?: unknown }

function stubDeps(log: CallLog): Required<Pick<LaunchDeps, 'uploadImage' | 'uploadMetadata' | 'buildTx'>> {
  return {
    uploadImage: async () => {
      log.imageUploads += 1
      return { cid: 'bafyimage', url: 'https://ipfs.filebase.io/ipfs/bafyimage' }
    },
    uploadMetadata: async (metadata) => {
      log.metadataUploads += 1
      return { cid: 'bafymeta', url: 'https://ipfs.filebase.io/ipfs/bafymeta' }
    },
    buildTx: async (params) => {
      log.builds += 1
      log.lastTx = params
      return {
        transaction: 'AAAAbase64tx',
        mintAddress: PAYER,
        mintSigned: true,
        poolAddress: PAYER,
        lastValidBlockHeight: 42,
      }
    },
  }
}

function launchDeps(
  catDeps: CatalogDeps,
  log: CallLog,
  extra: LaunchDeps = {},
): LaunchDeps {
  return {
    loadCatalog: (ip) => getConfigCatalogWithGeo(ip, catDeps),
    fetchCauses: async () => [],
    fetchCauseModes: async () => ({
      modes: [
        { mode: 'managed', status: 'active', pickers: ['launch'], isFinal: true, launchEnabled: true },
        { mode: 'cause', status: 'active', pickers: ['launch'], isFinal: true, launchEnabled: true },
        { mode: 'project', status: 'active', pickers: ['launch'], isFinal: true, launchEnabled: true },
        { mode: 'tbd', status: 'active', pickers: ['launch'], isFinal: false, launchEnabled: true },
        { mode: 'x', status: 'active', pickers: ['launch'], isFinal: false, launchEnabled: false },
        { mode: 'reddit', status: 'active', pickers: ['launch'], isFinal: false, launchEnabled: false },
        { mode: 'dao', status: 'planned', pickers: [], isFinal: false, launchEnabled: false },
      ],
      fallbackMode: 'managed',
    }),
    fetchIdeaModes: async () => ({
      modes: [
        { mode: 'managed', status: 'active', pickers: ['launch'], isFinal: true },
        { mode: 'tbd', status: 'active', pickers: ['launch'], isFinal: false },
        { mode: 'realms', status: 'active', pickers: ['launch'], isFinal: true },
        { mode: 'direct', status: 'active', pickers: ['launch'], isFinal: true },
        { mode: 'x', status: 'active', pickers: ['launch'], isFinal: false },
        { mode: 'reddit', status: 'active', pickers: ['launch'], isFinal: false },
      ],
      takeoverMode: 'realms',
      milestonesEnabled: false,
    }),
    ...stubDeps(log),
    ...extra,
  }
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configKey: LIVE_CONFIG_KEY,
    category: 'meme',
    name: 'Test Coin',
    symbol: 'tst',
    description: 'a test coin launch',
    image: PNG_1PX,
    payerPublicKey: PAYER,
    ...overrides,
  }
}

function ideaBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseBody({
    category: 'idea',
    problem: 'Agents need better launch rails',
    useCases: ['infrastructure'],
    prototype: 'https://proto.example.com',
    ...overrides,
  })
}

async function expectLaunchError(
  fn: () => Promise<unknown>,
  status: number,
  match: RegExp | string,
): Promise<LaunchError> {
  try {
    await fn()
  } catch (err) {
    assert.ok(err instanceof LaunchError, `expected LaunchError, got ${err}`)
    assert.equal(err.status, status, `expected status ${status}, got ${err.status} (${err.message})`)
    const text = `${err.message} ${JSON.stringify(err.fields)}`
    if (match instanceof RegExp) assert.match(text, match)
    else assert.ok(text.includes(match), `expected "${text}" to include "${match}"`)
    return err
  }
  assert.fail('expected LaunchError')
}

beforeEach(() => resetConfigCatalogCachesForTests())
afterEach(() => resetConfigCatalogCachesForTests())

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('POST /api/launch — happy path', () => {
  it('launches a meme on the live config: uploads through the proxy, builds the tx', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    const result = await prepareLaunch(baseBody(), '203.0.113.10', deps)
    assert.equal(log.imageUploads, 1)
    assert.equal(log.metadataUploads, 1)
    assert.equal(log.builds, 1)
    assert.equal(result.configKey, LIVE_CONFIG_KEY)
    assert.equal(result.category, 'meme')
    assert.equal(result.quoteMint, SKR_MINT)
    assert.equal(result.metadataUrl, 'https://ipfs.filebase.io/ipfs/bafymeta')
    assert.equal(result.lastValidBlockHeight, 42, 'the build seam\'s expiry bound must pass through')
    const txParams = log.lastTx as { firstBuyAtoms?: bigint; metadataUrl: string }
    assert.equal(txParams.firstBuyAtoms, undefined)
    assert.equal(txParams.metadataUrl, 'https://ipfs.filebase.io/ipfs/bafymeta')
  })

  it('writes the app metadata shape: launchType, creatorAddress, createdAt, canonical symbol', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    let uploadedMeta: Record<string, unknown> | null = null
    const deps = launchDeps(await catalogDeps(), log, {
      uploadMetadata: async (metadata) => {
        log.metadataUploads += 1
        uploadedMeta = metadata
        return { cid: 'bafymeta', url: 'https://ipfs.filebase.io/ipfs/bafymeta' }
      },
    })
    await prepareLaunch(
      baseBody({ symbol: ' $tst ', donation: { mode: 'cause', cause: 'x' } }),
      '203.0.113.10',
      { ...deps, fetchCauses: async () => [{ slug: 'x', status: 'shipping' }] },
    )
    const meta = uploadedMeta as Record<string, unknown> | null
    assert.ok(meta)
    assert.equal(meta.symbol, 'TST')
    assert.equal(meta.launchType, 'meme')
    assert.equal(meta.creatorAddress, PAYER)
    assert.equal(meta.image, 'https://ipfs.filebase.io/ipfs/bafyimage')
    assert.equal(meta.donationCause, 'x')
    assert.equal(meta.donationFunding, undefined)
    assert.equal(meta.donationProject, undefined)
    assert.equal(typeof meta.createdAt, 'string')
  })

  it('always declares launchType = the chosen category (the backend fails closed on a missing type)', () => {
    for (const category of ['meme', 'idea', 'startup'] as const) {
      const meta = buildLaunchMetadata({
        name: 'Coin',
        symbol: 'COIN',
        description: 'd',
        imageUrl: 'https://gw.example/img.png',
        category,
        creatorAddress: PAYER,
      })
      assert.equal(meta.launchType, category)
    }
  })
})

// ─── Request/config rejections ────────────────────────────────────────────────

describe('POST /api/launch — request rejections', () => {
  it('rejects an unknown configKey', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ configKey: 'NotAServedConfig11111111111111111111' }), null, deps),
      400,
      /Unknown configKey/,
    )
    assert.equal(log.imageUploads, 0)
  })

  it('rejects a category the config is not offered for', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    // Legacy config served under "meme" only.
    const scenario = serveOption('meme', {
      configKey: LEGACY_CONFIG_KEY,
      optionId: 'legacy',
      quoteMint: USDC_MINT,
    })
    const deps = launchDeps(await catalogDeps({ mobileConfig: scenario }), log)
    await expectLaunchError(
      () =>
        prepareLaunch(
          ideaBody({ configKey: LEGACY_CONFIG_KEY }),
          null,
          deps,
        ),
      400,
      /not offered for category "idea"/,
    )
  })

  it('accepts imageUrl through the safe fetch seam and uploads its bytes', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    let fetched: string | null = null
    let uploaded: { bytes: Buffer; contentType: string } | null = null
    const deps = launchDeps(await catalogDeps(), log, {
      fetchImage: async (url) => {
        fetched = url
        return {
          bytes: Buffer.from(PNG_1PX, 'base64'),
          contentType: 'image/png',
          fileName: 'image.png',
        }
      },
      uploadImage: async (image) => {
        log.imageUploads += 1
        uploaded = image
        return { cid: 'bafyimage', url: 'https://ipfs.filebase.io/ipfs/bafyimage' }
      },
    })
    const result = await prepareLaunch(
      baseBody({ image: undefined, imageUrl: ' https://cdn.example.com/logo.png ' }),
      '203.0.113.10',
      deps,
    )
    assert.equal(fetched, 'https://cdn.example.com/logo.png')
    assert.equal(uploaded!.contentType, 'image/png')
    assert.equal(log.imageUploads, 1)
    assert.equal(log.builds, 1)
    assert.equal(result.imageUrl, 'https://ipfs.filebase.io/ipfs/bafyimage')
  })

  it('re-pins a pre-existing /ipfs/ URL instead of passing it through', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    let fetched: string | null = null
    let uploadedMeta: Record<string, unknown> | null = null
    const deps = launchDeps(await catalogDeps(), log, {
      fetchImage: async (url) => {
        fetched = url
        return {
          bytes: Buffer.from(PNG_1PX, 'base64'),
          contentType: 'image/png',
          fileName: 'image.png',
        }
      },
      uploadMetadata: async (metadata) => {
        log.metadataUploads += 1
        uploadedMeta = metadata
        return { cid: 'bafymeta', url: 'https://ipfs.filebase.io/ipfs/bafymeta' }
      },
    })
    const result = await prepareLaunch(
      baseBody({ image: undefined, imageUrl: 'https://ipfs.filebase.io/ipfs/bafyold' }),
      '203.0.113.10',
      deps,
    )
    // The /ipfs/ input is fetched through the guard like any other URL…
    assert.equal(fetched, 'https://ipfs.filebase.io/ipfs/bafyold')
    assert.equal(log.imageUploads, 1)
    // …and the caller's URL never reaches the metadata — only the proxy's
    // re-pinned URL does.
    assert.equal(result.imageUrl, 'https://ipfs.filebase.io/ipfs/bafyimage')
    assert.equal(uploadedMeta!.image, 'https://ipfs.filebase.io/ipfs/bafyimage')
  })

  it('surfaces an imageUrl guard refusal as a LaunchError before any upload', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, {
      fetchImage: async () => {
        throw new ImageFetchError('imageUrl targets a blocked address: 127.0.0.1', 400)
      },
    })
    await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ image: undefined, imageUrl: 'http://127.0.0.1/x.png' }),
          null,
          deps,
        ),
      400,
      /blocked address/,
    )
    assert.equal(log.imageUploads, 0)
    assert.equal(log.metadataUploads, 0)
    assert.equal(log.builds, 0)
  })

  it('rejects a request passing both image and imageUrl', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ imageUrl: 'https://example.com/x.png' }),
          null,
          deps,
        ),
      400,
      /only one of `image`.*`imageUrl`/,
    )
    assert.equal(log.imageUploads, 0)
  })

  it('rejects a missing image entirely (neither field)', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ image: undefined }), null, deps),
      400,
      /image is required/,
    )
    assert.equal(log.imageUploads, 0)
  })

  it('rejects a missing/undecodable image before any network work', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ image: 'not base64 !!!' }), null, deps),
      400,
      /base64|image/i,
    )
    assert.equal(log.imageUploads, 0)
  })

  it('rejects an image whose bytes are not a supported type', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const notImage = Buffer.from('{"json": true}').toString('base64')
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ image: notImage }), null, deps),
      400,
      /Unsupported image type/,
    )
    assert.equal(log.imageUploads, 0)
  })

  it('enforces the app identity limits', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(() => prepareLaunch(baseBody({ name: 'ab' }), null, deps), 400, /name must be at least/)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ name: 'x'.repeat(40) }), null, deps),
      400,
      /name must be at most/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ symbol: 'TWELVECHARS!' }), null, deps),
      400,
      /symbol must be at most/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ description: 'x'.repeat(2001) }), null, deps),
      400,
      /description must be at most/,
    )
    assert.equal(log.imageUploads, 0)
    assert.equal(log.builds, 0)
  })

  it('rejects a bad payerPublicKey', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ payerPublicKey: 'not-a-key' }), null, deps),
      400,
      /payerPublicKey/,
    )
  })
})

// ─── Caller-supplied mint ─────────────────────────────────────────────────────

describe('POST /api/launch — mintPublicKey', () => {
  const MINT = Keypair.generate().publicKey.toBase58()

  it('passes a fresh caller mint through to the builder', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const checked: string[] = []
    const deps = launchDeps(await catalogDeps(), log, {
      mintAccountExists: async (mint) => {
        checked.push(mint)
        return false
      },
    })
    await prepareLaunch(baseBody({ mintPublicKey: MINT }), null, deps)
    assert.deepEqual(checked, [MINT])
    assert.equal((log.lastTx as { mintPublicKey?: string }).mintPublicKey, MINT)
  })

  it('omits it from the build when absent (service-generated mint)', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, {
      mintAccountExists: async () => assert.fail('no existence check without mintPublicKey'),
    })
    await prepareLaunch(baseBody(), null, deps)
    assert.equal('mintPublicKey' in (log.lastTx as object), false)
  })

  it('refuses an invalid, off-curve or payer-equal key before any upload', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    const offCurve = PublicKey.findProgramAddressSync([Buffer.from('mint')], SystemProgram.programId)[0].toBase58()
    for (const [mintPublicKey, match] of [
      ['not-a-key', /not a valid Solana address/],
      [offCurve, /on-curve/],
      [PAYER, /must differ from payerPublicKey/],
      ['  ', /non-empty/],
    ] as const) {
      await expectLaunchError(() => prepareLaunch(baseBody({ mintPublicKey }), null, deps), 400, match)
    }
    assert.equal(log.imageUploads, 0)
    assert.equal(log.builds, 0)
  })

  it('refuses a mint that already exists on-chain with 409, before any upload', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, { mintAccountExists: async () => true })
    const err = await expectLaunchError(
      () => prepareLaunch(baseBody({ mintPublicKey: MINT }), null, deps),
      409,
      /already has an on-chain account/,
    )
    assert.equal(err.fields.error, 'mint_already_exists')
    assert.equal(err.fields.mintAddress, MINT)
    assert.equal(log.imageUploads, 0)
    assert.equal(log.builds, 0)
  })
})

// ─── Donation rules ───────────────────────────────────────────────────────────

describe('POST /api/launch — donation rules', () => {
  const OFFERED: BackendCause[] = [
    { slug: 'education', status: 'shipping', eligibleMemberCount: 3 },
    { slug: 'climate', status: 'shipping', eligibleMemberCount: 2 },
  ]

  it('rejects donation on idea and startup categories', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, {
      fetchCauses: async () => OFFERED,
    })
    await expectLaunchError(
      () => prepareLaunch(ideaBody({ donation: { mode: 'managed' } }), null, deps),
      400,
      /only valid for meme/,
    )
    await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({
            category: 'startup',
            problem: 'p', useCases: ['saas'], deck: 'https://deck.example.com',
            donation: { mode: 'managed' },
          }),
          null,
          deps,
        ),
      400,
      /only valid for meme/,
    )
    assert.equal(log.imageUploads, 0)
  })

  it('rejects donation on a non-cause-capable config', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    // The real legacy decode patched to a non-authority claimer.
    const scenario = serveOption('meme', { configKey: LEGACY_CONFIG_KEY, quoteMint: USDC_MINT })
    const catDeps = await catalogDeps({
      mobileConfig: scenario,
      extraPoolConfigs: {
        [LEGACY_CONFIG_KEY]: (decoded) => ({ ...decoded, feeClaimer: NON_AUTHORITY_CLAIMER }),
      },
    })
    await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ configKey: LEGACY_CONFIG_KEY, donation: { mode: 'managed' } }),
          null,
          launchDeps(catDeps, log),
        ),
      400,
      /not cause-capable/,
    )
  })

  it('requires donation for meme on a cause-capable config while causes are offered', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, {
      fetchCauses: async () => OFFERED,
    })
    const err = await expectLaunchError(
      () => prepareLaunch(baseBody(), null, deps),
      400,
      /donation_required|donation is required/,
    )
    assert.equal(err.fields.error, 'donation_required')
    assert.deepEqual(err.fields.causesOffered, ['education', 'climate'])
    assert.equal(log.imageUploads, 0)
    assert.equal(log.builds, 0)
  })

  it('accepts meme without donation on a non-cause-capable config', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const scenario = serveOption('meme', { configKey: LEGACY_CONFIG_KEY, quoteMint: USDC_MINT })
    const catDeps = await catalogDeps({
      mobileConfig: scenario,
      extraPoolConfigs: {
        [LEGACY_CONFIG_KEY]: (decoded) => ({ ...decoded, feeClaimer: NON_AUTHORITY_CLAIMER }),
      },
    })
    const result = await prepareLaunch(
      baseBody({ configKey: LEGACY_CONFIG_KEY }),
      null,
      launchDeps(catDeps, log),
    )
    assert.equal(result.configKey, LEGACY_CONFIG_KEY)
    assert.equal(log.builds, 1)
  })

  it('accepts meme without donation on a capable config when no causes are offered', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, {
      fetchCauses: async () => [{ slug: 'paused-one', status: 'paused' }],
    })
    const result = await prepareLaunch(baseBody(), null, deps)
    assert.equal(result.category, 'meme')
    assert.equal(log.builds, 1)
  })

  it('rejects a donation mode outside the launch modes (x/reddit/dao are launch-disabled)', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, { fetchCauses: async () => OFFERED })
    await expectLaunchError(
      () => prepareLaunch(baseBody({ donation: { mode: 'x', handle: 'abc' } }), null, deps),
      400,
      /not selectable at launch/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ donation: { mode: 'dao' } }), null, deps),
      400,
      /not selectable at launch/,
    )
  })

  it('serializes the three donation claim shapes exactly like the app', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const metas: Record<string, unknown>[] = []
    const deps = launchDeps(await catalogDeps(), log, {
      fetchCauses: async () => OFFERED,
      uploadMetadata: async (m) => {
        log.metadataUploads += 1
        metas.push(m)
        return { cid: 'c', url: 'u' }
      },
    })
    await prepareLaunch(baseBody({ donation: { mode: 'cause', cause: 'education' } }), null, deps)
    await prepareLaunch(baseBody({ donation: { mode: 'project', project: ' 42 ' } }), null, deps)
    await prepareLaunch(baseBody({ donation: { mode: 'managed' } }), null, deps)
    await prepareLaunch(baseBody({ donation: { mode: 'tbd' } }), null, deps)
    assert.equal(metas[0].donationCause, 'education')
    assert.equal(metas[1].donationProject, '42')
    assert.deepEqual(metas[2].donationFunding, { mode: 'managed', params: {} })
    assert.deepEqual(metas[3].donationFunding, { mode: 'tbd', params: {} })
    // Exactly one claim field per document.
    for (const m of metas) {
      const present = ['donationCause', 'donationProject', 'donationFunding'].filter((f) => m[f] != null)
      assert.equal(present.length, 1)
    }
  })

  it('rejects a non-shipping cause slug and a bad project id', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, { fetchCauses: async () => OFFERED })
    await expectLaunchError(
      () => prepareLaunch(baseBody({ donation: { mode: 'cause', cause: 'nonexistent' } }), null, deps),
      400,
      /not a shipping cause/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ donation: { mode: 'project', project: '0' } }), null, deps),
      400,
      /positive Giveth project id/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ donation: { mode: 'project', project: '12.5' } }), null, deps),
      400,
      /positive Giveth project id/,
    )
    assert.equal(log.imageUploads, 0)
  })
})

// ─── ideaFunding rules ────────────────────────────────────────────────────────

describe('POST /api/launch — ideaFunding rules', () => {
  it('rejects ideaFunding on non-idea categories', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ ideaFunding: { mode: 'tbd' } }), null, deps),
      400,
      /only valid for idea/,
    )
    assert.equal(log.imageUploads, 0)
  })

  it('serializes the idea claim shapes exactly like the app', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const metas: Record<string, unknown>[] = []
    const deps = launchDeps(await catalogDeps(), log, {
      uploadMetadata: async (m) => {
        log.metadataUploads += 1
        metas.push(m)
        return { cid: 'c', url: 'u' }
      },
    })
    await prepareLaunch(ideaBody({ ideaFunding: { mode: 'tbd' } }), null, deps)
    await prepareLaunch(ideaBody({ ideaFunding: { mode: 'direct', address: PAYER } }), null, deps)
    await prepareLaunch(ideaBody({ ideaFunding: { mode: 'x', handle: '@SomeHandle' } }), null, deps)
    assert.equal(metas[0].ideaFunding, 'tbd')
    assert.deepEqual(metas[1].ideaFunding, { mode: 'direct', address: PAYER })
    assert.deepEqual(metas[2].ideaFunding, { mode: 'x', handle: 'somehandle' })
    // managed/realms are withheld from launch picks (owner decision).
    await expectLaunchError(
      () => prepareLaunch(ideaBody({ ideaFunding: { mode: 'managed' } }), null, deps),
      400,
      /not selectable at launch/,
    )
    await expectLaunchError(
      () => prepareLaunch(ideaBody({ ideaFunding: { mode: 'realms' } }), null, deps),
      400,
      /not selectable at launch/,
    )
  })

  it('rejects an off-curve direct address', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    // Derive a PDA-style off-curve address deterministically.
    const { PublicKey } = await import('@solana/web3.js')
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('x')],
      new PublicKey(DONATION_CLAIM_AUTHORITY),
    )
    await expectLaunchError(
      () => prepareLaunch(ideaBody({ ideaFunding: { mode: 'direct', address: pda.toBase58() } }), null, deps),
      400,
      /on-curve/,
    )
  })

  it('requires idea fields: problem, useCases, prototype', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(() => prepareLaunch(ideaBody({ problem: '' }), null, deps), 400, /problem is required/)
    await expectLaunchError(() => prepareLaunch(ideaBody({ useCases: [] }), null, deps), 400, /useCases is required/)
    await expectLaunchError(() => prepareLaunch(ideaBody({ prototype: '' }), null, deps), 400, /prototype is required/)
    assert.equal(log.imageUploads, 0)
  })
})

// ─── Geo refusals before upload ───────────────────────────────────────────────

describe('POST /api/launch — geo refusals happen before any upload', () => {
  async function geoScenario(restricted: string[]): Promise<CatalogDeps> {
    return catalogDeps({
      mobileConfig: { geo: { region: 'US', restricted, betaGated: false } },
    })
  }

  it('refuses an idea launch when idea.create is restricted — no upload attempted', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await geoScenario(['idea.create']), log)
    const err = await expectLaunchError(
      () => prepareLaunch(ideaBody(), '1.2.3.4', deps),
      403,
      /geo_restricted|idea\.create/,
    )
    assert.ok(err instanceof GeoRestrictedError)
    assert.equal(err.fields.feature, 'idea.create')
    assert.equal(log.imageUploads, 0)
    assert.equal(log.metadataUploads, 0)
    assert.equal(log.builds, 0)
  })

  it('refuses a startup launch when startup.create is restricted', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await geoScenario(['startup.create']), log)
    await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ category: 'startup', problem: 'p', useCases: ['saas'], deck: 'https://d.example.com' }),
          null,
          deps,
        ),
      403,
      /startup\.create/,
    )
    assert.equal(log.imageUploads, 0)
  })

  it('refuses a meme launch when cause.marketing is restricted', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await geoScenario(['cause.marketing']), log)
    const err = await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ donation: { mode: 'managed' } }),
          null,
          deps,
        ),
      403,
      /cause\.marketing/,
    )
    assert.equal((err as GeoRestrictedError).fields.feature, 'cause.marketing')
    assert.equal(log.imageUploads, 0)
  })

  it('refuses a meme managed pick under cause.managed_hidden, a cause pick under cause.specific_hidden', async () => {
    const managedLog: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const managedDeps = launchDeps(await geoScenario(['cause.managed_hidden']), managedLog)
    const err1 = await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ donation: { mode: 'managed' } }),
          null,
          managedDeps,
        ),
      403,
      /cause\.managed_hidden/,
    )
    assert.equal((err1 as GeoRestrictedError).fields.feature, 'cause.managed_hidden')
    assert.equal(managedLog.imageUploads, 0)

    const specificLog: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const specificDeps = launchDeps(await geoScenario(['cause.specific_hidden']), specificLog, {
      fetchCauses: async () => [{ slug: 'education', status: 'shipping' }],
    })
    const err2 = await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ donation: { mode: 'cause', cause: 'education' } }),
          null,
          specificDeps,
        ),
      403,
      /cause\.specific_hidden/,
    )
    assert.equal((err2 as GeoRestrictedError).fields.feature, 'cause.specific_hidden')
    assert.equal(specificLog.imageUploads, 0)
  })

  it('refuses a stock-quoted launch under stock.create even with open category keys', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const stockOptions: Partial<MobileConfigResponse> = {
      geo: { region: 'US', restricted: ['stock.create'], betaGated: false },
      quoteAssets: [
        { mint: SKR_MINT, symbol: 'SKR', decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM },
        { mint: STOCK_MINT, symbol: 'STK', decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, issuer: 'x' },
      ],
      launchConfigOptions: {
        meme: [
          { configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT },
          { configKey: STOCK_CONFIG_KEY, optionId: 'stock', quoteMint: STOCK_MINT },
        ],
        idea: [{ configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT }],
        startup: [{ configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT }],
      },
    }
    const catDeps = await catalogDeps({
      mobileConfig: stockOptions,
      // The real live decode patched to the stock quote mint — no fabricated account.
      extraPoolConfigs: {
        [STOCK_CONFIG_KEY]: (decoded) => ({ ...decoded, quoteMint: STOCK_MINT }),
      },
      mintInfo: async () => ({ decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, scaledUiAmount: null }),
    })
    const deps = launchDeps(catDeps, log)
    const err = await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ configKey: STOCK_CONFIG_KEY, donation: { mode: 'managed' } }),
          null,
          deps,
        ),
      403,
      /stock\.create/,
    )
    assert.equal((err as GeoRestrictedError).fields.feature, 'stock.create')
    assert.equal(log.imageUploads, 0)
  })

  it('fails open on a malformed/missing geo verdict', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const catDeps = await catalogDeps({ mobileConfig: { geo: 'not-an-object' as never } })
    const result = await prepareLaunch(baseBody(), null, launchDeps(catDeps, log))
    void result
    assert.equal(result.category, 'meme')
    assert.equal(log.builds, 1)
  })
})

// ─── First buy ────────────────────────────────────────────────────────────────

describe('POST /api/launch — first buy', () => {
  it('rejects first buy on a config without enableFirstSwapWithMinFee', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const scenario = serveOption('meme', { configKey: LEGACY_CONFIG_KEY, quoteMint: USDC_MINT })
    const catDeps = await catalogDeps({
      mobileConfig: scenario,
      extraPoolConfigs: {
        [LEGACY_CONFIG_KEY]: (decoded) => ({ ...decoded, feeClaimer: NON_AUTHORITY_CLAIMER }),
      },
    })
    const deps = launchDeps(catDeps, log)
    await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ configKey: LEGACY_CONFIG_KEY, firstBuyAtoms: '1000' }),
          null,
          deps,
        ),
      400,
      /does not support a creator first buy/,
    )
    assert.equal(log.builds, 0)
  })

  it('passes firstBuyAtoms through as raw quote atoms', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await prepareLaunch(baseBody({ firstBuyAtoms: '123456789' }), null, deps)
    assert.equal((log.lastTx as { firstBuyAtoms?: bigint }).firstBuyAtoms, 123456789n)
  })

  it('converts firstBuyAmount display units with the quote decimals', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    // SKR decimals = 6 → "1.5" → 1,500,000 atoms (NOT 1.5e9 lamports).
    const deps = launchDeps(await catalogDeps(), log)
    await prepareLaunch(baseBody({ firstBuyAmount: '1.5' }), null, deps)
    assert.equal((log.lastTx as { firstBuyAtoms?: bigint }).firstBuyAtoms, 1500000n)
  })

  it('forwards firstBuySlippageBps to the builder (DD-S-2)', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await prepareLaunch(
      baseBody({ firstBuyAtoms: '1000', firstBuySlippageBps: 250 }),
      null,
      deps,
    )
    const tx = log.lastTx as { firstBuySlippageBps?: number }
    assert.equal(tx.firstBuySlippageBps, 250)
  })

  it('omits firstBuySlippageBps when unset (builder default applies)', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await prepareLaunch(baseBody({ firstBuyAtoms: '1000' }), null, deps)
    const tx = log.lastTx as { firstBuySlippageBps?: number }
    assert.equal(tx.firstBuySlippageBps, undefined)
  })

  it('caps firstBuySlippageBps at 1000 unless allowHighSlippage lifts it to 5000 (DD-S-2)', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    const err = await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ firstBuyAtoms: '1000', firstBuySlippageBps: 1500 }),
          null,
          deps,
        ),
      400,
      /firstBuySlippageBps/,
    )
    assert.equal(err.fields.error, 'slippage_too_high')
    assert.equal(err.fields.maxSlippageBps, 1000)
    assert.equal(log.builds, 0)
    // The escape hatch works but never lets the floor hit zero.
    await prepareLaunch(
      baseBody({ firstBuyAtoms: '1000', firstBuySlippageBps: 2000, allowHighSlippage: true }),
      null,
      deps,
    )
    assert.equal(
      (log.lastTx as { firstBuySlippageBps?: number }).firstBuySlippageBps,
      2000,
    )
    const over = await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({
            firstBuyAtoms: '1000',
            firstBuySlippageBps: 5001,
            allowHighSlippage: true,
          }),
          null,
          deps,
        ),
      400,
      /firstBuySlippageBps/,
    )
    assert.equal(over.fields.maxSlippageBps, 5000)
  })

  it('floor-divides by a non-unit ScaledUiAmount multiplier', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const stockOptions: Partial<MobileConfigResponse> = {
      quoteAssets: [
        { mint: SKR_MINT, symbol: 'SKR', decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM },
        { mint: STOCK_MINT, symbol: 'STK', decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, issuer: 'x' },
      ],
      launchConfigOptions: {
        meme: [
          { configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT },
          { configKey: STOCK_CONFIG_KEY, optionId: 'stock', quoteMint: STOCK_MINT },
        ],
        idea: [{ configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT }],
        startup: [{ configKey: LIVE_CONFIG_KEY, optionId: 'default', quoteMint: SKR_MINT }],
      },
    }
    const catDeps = await catalogDeps({
      mobileConfig: stockOptions,
      extraPoolConfigs: {
        [STOCK_CONFIG_KEY]: (decoded) => ({ ...decoded, quoteMint: STOCK_MINT }),
      },
      // The Token-2022 mint carries a live ScaledUiAmount multiplier of 2.
      mintInfo: async () => ({
        decimals: 6,
        tokenProgram: TOKEN_2022_PROGRAM,
        scaledUiAmount: { multiplier: '2', newMultiplier: '2', newMultiplierEffectiveTimestamp: 0 },
      }),
    })
    // Display "10" of a 6-decimal mint scaled by 2 → floor(10e6 / 2) = 5e6 atoms.
    const deps = launchDeps(catDeps, log)
    await prepareLaunch(
      baseBody({ configKey: STOCK_CONFIG_KEY, firstBuyAmount: '10', donation: { mode: 'managed' } }),
      null,
      deps,
    )
    assert.equal((log.lastTx as { firstBuyAtoms?: bigint }).firstBuyAtoms, 5000000n)
    // 1 atom / multiplier 2 floors to 0 — a requested first buy is never silently dropped.
    await expectLaunchError(
      () =>
        prepareLaunch(
          baseBody({ configKey: STOCK_CONFIG_KEY, firstBuyAmount: '0.000001', donation: { mode: 'managed' } }),
          null,
          deps,
        ),
      400,
      /rounds to 0 atoms/,
    )
  })

  it('rejects a zero-or-less display first buy and malformed atoms', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ firstBuyAtoms: '-5' }), null, deps),
      400,
      /firstBuyAtoms/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ firstBuyAmount: '-1' }), null, deps),
      400,
      /firstBuyAmount/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ firstBuyAtoms: 'abc' }), null, deps),
      400,
      /firstBuyAtoms/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ firstBuyAmount: '1.0000001' }), null, deps),
      400,
      /firstBuyAmount/,
    )
    // "0" parses to zero → treated as no first buy, never passed to the SDK.
    await prepareLaunch(baseBody({ firstBuyAmount: '0' }), null, deps)
    assert.equal((log.lastTx as { firstBuyAtoms?: bigint }).firstBuyAtoms, undefined)
    assert.equal(log.builds, 1)
  })

  it('rejects unsafe-integer numbers and values above u64 max', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    await expectLaunchError(
      () => prepareLaunch(baseBody({ firstBuyAtoms: 2 ** 60 }), null, deps),
      400,
      /safe integer/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ firstBuyAtoms: '18446744073709551616' }), null, deps),
      400,
      /u64/,
    )
    await prepareLaunch(baseBody({ firstBuyAtoms: '18446744073709551615' }), null, deps)
    assert.equal(log.builds, 1)
  })

  it('rejects a display first buy whose converted atoms exceed u64, and non-numeric input', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log)
    // 99,999,999,999,999 × 10^6 overflows the documented u64 bound — refused
    // before any upload or build.
    await expectLaunchError(
      () => prepareLaunch(baseBody({ firstBuyAmount: '99999999999999' }), null, deps),
      400,
      /u64/,
    )
    await expectLaunchError(
      () => prepareLaunch(baseBody({ firstBuyAmount: 'abc' }), null, deps),
      400,
      /firstBuyAmount/,
    )
    assert.equal(log.imageUploads, 0)
    assert.equal(log.builds, 0)
  })

  it('converts with the mint decimals read on-chain — the record never wins over the live read', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    // The on-chain read reports 8 decimals where the built-in SKR record
    // says 6 — the chain read must drive the conversion (TB-S-2: the live
    // quote mint's decimals, not a constant).
    const catDeps = await catalogDeps({
      mintInfo: async () => ({
        decimals: 8,
        tokenProgram: SPL_TOKEN_PROGRAM,
        scaledUiAmount: null,
      }),
    })
    await prepareLaunch(baseBody({ firstBuyAmount: '1.5' }), null, launchDeps(catDeps, log))
    assert.equal((log.lastTx as { firstBuyAtoms?: bigint }).firstBuyAtoms, 150_000_000n)
  })

  it('recorded simulation: the built transaction carries the quote atoms in the first-buy swap instruction', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const simLog = { calls: 0 }
    // The REAL SDK client over recorded on-chain accounts: the production
    // pool config and the SKR mint (SPL, 6 decimals). Every other account —
    // the buyer's ATAs, the token badge — resolves absent, as on chain.
    const accountInfo = (name: string) => {
      const value = loadFixture<{
        result: {
          value: {
            data: [string, string]
            executable: boolean
            lamports: number
            owner: string
            rentEpoch: number
          } | null
        }
      }>(name).result.value
      return (
        value && {
          data: Buffer.from(value.data[0], 'base64'),
          executable: value.executable,
          lamports: value.lamports,
          owner: new PublicKey(value.owner),
          rentEpoch: value.rentEpoch,
        }
      )
    }
    const configInfo = accountInfo(LIVE_CONFIG_ACCOUNT)
    const skrMintInfo = accountInfo('skr-mint.getAccountInfo.json')
    const serve = (key: string) =>
      key === LIVE_CONFIG_KEY ? configInfo : key === SKR_MINT ? skrMintInfo : null
    const connection = {
      getAccountInfo: async (pk: PublicKey) => serve(pk.toBase58()),
      getAccountInfoAndContext: async (pk: PublicKey) => ({
        context: { slot: 1 },
        value: serve(pk.toBase58()),
      }),
      getLatestBlockhash: async () => ({
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 7,
      }),
      // The recorded clean simulation — sigVerify is false by construction:
      // a legacy `simulateTransaction` never verifies signatures.
      simulateTransaction: async () => {
        simLog.calls += 1
        return {
          context: { slot: 1 },
          value: { err: null, unitsConsumed: 144_259, logs: [] },
        }
      },
      getRecentPrioritizationFees: async () => [],
      getSlot: async () => 1,
      getBlockTime: async () => 1_700_000_000,
    } as unknown as Connection
    const client = new DynamicBondingCurveClient(connection as never, 'confirmed')
    // `buildTx: undefined` drops the stub so prepareLaunch runs the REAL
    // buildLaunchTx (SDK createPoolWithFirstBuy + compute estimation).
    const deps = launchDeps(await catalogDeps(), log, {
      buildTx: undefined,
      buildTxDeps: { connection, client },
    })
    const result = await prepareLaunch(baseBody({ firstBuyAmount: '1.5' }), null, deps)

    assert.equal(result.firstBuyAtoms, '1500000')
    assert.equal(result.quoteDecimals, 6)
    // The builder's compute estimation simulated the finished transaction.
    assert.ok(simLog.calls >= 1, 'expected the recorded simulation to run')
    // The DBC `swap` instruction's amountIn (u64 at offset 8 after the
    // anchor discriminator) is exactly the converted quote atoms.
    const tx = Transaction.from(Buffer.from(result.transaction, 'base64'))
    const swapIx = tx.instructions.find(
      (ix) =>
        ix.programId.toBase58() === DBC_PROGRAM_ID &&
        ix.data.subarray(0, 8).equals(SWAP_IX_DISCRIMINATOR),
    )
    assert.ok(swapIx, 'expected the DBC first-buy swap instruction')
    assert.equal(swapIx.data.readBigUInt64LE(8), 1_500_000n)
    // DD-S-2: minimumAmountOut is the real opening-curve quote output
    // discounted by the default 50 bps — recompute it through the SDK's own
    // simulated-quote path rather than pinning a number.
    const decodedConfig = unwrapConfig(
      await client.state.getPoolConfig(new PublicKey(LIVE_CONFIG_KEY)),
    )
    const expectedQuote = client.pool.getQuoteFromInputAmount({
      config: decodedConfig as never,
      swapBaseForQuote: false,
      amountIn: toBN(1_500_000n),
      slippageBps: 50,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: true,
      currentPoint: await getCurrentPoint(connection, 0),
    })
    const expectedFloor =
      (BigInt(expectedQuote.outputAmount.toString()) * 9_950n) / 10_000n
    assert.ok(expectedFloor > 1n, 'expected a real quoted output, not a dust floor')
    assert.equal(swapIx.data.readBigUInt64LE(16), expectedFloor)
  })
})

/** Anchor discriminator of the DBC `swap` instruction (IDL). */
const SWAP_IX_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200])

describe('POST /api/launch — causes unavailable', () => {
  it('fails closed with 503 for a cause-capable meme without donation', async () => {
    const log: CallLog = { imageUploads: 0, metadataUploads: 0, builds: 0 }
    const deps = launchDeps(await catalogDeps(), log, {
      fetchCauses: async () => {
        throw new Error('backend down')
      },
    })
    const err = await expectLaunchError(() => prepareLaunch(baseBody(), null, deps), 503, /unavailable/)
    assert.equal(err.fields.error, 'causes_unavailable')
    assert.equal(log.builds, 0)
  })
})

describe('GET /api/causes response', () => {
  it('unwraps the backend { causes } envelope (captured response)', () => {
    const body = JSON.parse(readFileSync(new URL('./fixtures/causes.json', import.meta.url), 'utf8'))
    const causes = parseCausesResponse(body)
    assert.ok(causes.length > 0)
    assert.equal(typeof causes[0].slug, 'string')
  })
  it('rejects a body without the envelope', () => {
    assert.throws(() => parseCausesResponse([{ slug: 'x' }]), /expected \{ causes/)
  })
})

// ─── Pure-function coverage for the ported domain pieces ─────────────────────

describe('claim + use-case helpers', () => {
  it('classifyUploadClaimKind mirrors the backend geo classifier', () => {
    assert.equal(classifyUploadClaimKind({}), 'managed')
    assert.equal(classifyUploadClaimKind({ donationCause: 'x' }), 'specific')
    assert.equal(classifyUploadClaimKind({ donationCause: '' }), 'managed')
    assert.equal(classifyUploadClaimKind({ donationProject: '42' }), 'specific')
    assert.equal(classifyUploadClaimKind({ donationProject: '0' }), 'managed')
    assert.equal(classifyUploadClaimKind({ donationFunding: { mode: 'managed', params: {} } }), 'managed')
    assert.equal(classifyUploadClaimKind({ donationFunding: { mode: 'tbd', params: {} } }), 'specific')
    // staged-off / unregistered modes degrade to managed
    assert.equal(classifyUploadClaimKind({ donationFunding: { mode: 'x', params: { handle: 'a' } } }), 'managed')
    assert.equal(classifyUploadClaimKind({ donationFunding: { mode: 'dao', params: {} } }), 'managed')
    assert.equal(classifyUploadClaimKind({ donationFunding: { mode: 'nope', params: {} } }), 'managed')
    // ambiguous → managed
    assert.equal(
      classifyUploadClaimKind({ donationCause: 'x', donationProject: '1' }),
      'managed',
    )
    // bare-string form works
    assert.equal(classifyUploadClaimKind({ donationFunding: 'tbd' }), 'specific')
  })

  it('use-case slugs normalize aliases, dedupe, and cap at 3', () => {
    assert.deepEqual(normalizeUseCaseSlugs('DePIN, local economy, gaming'), ['depin', 'local', 'gaming'])
    assert.deepEqual(normalizeUseCaseSlugs(['depin', 'DePIN', 'depin', 'other']), ['depin', 'other'])
    assert.deepEqual(normalizeUseCaseSlugs(['bogus', 'climate']), ['climate'])
    assert.deepEqual(normalizeUseCaseSlugs('meme'), []) // launchType is not a use case
    assert.equal(useCaseSlugsInCatalog(['depin', 'bogus'], 'idea').length, 1)
    assert.equal(useCaseSlugsInCatalog(['depin'], 'startup').length, 1)
    assert.equal(useCaseSlugsInCatalog(['inclusion'], 'startup').length, 0)
  })

  it('claim builders match the app serializers', () => {
    assert.deepEqual(buildDonationFundingClaim('managed'), { mode: 'managed', params: {} })
    assert.deepEqual(buildDonationFundingClaim('tbd'), { mode: 'tbd', params: {} })
    assert.equal(buildDonationFundingClaim('cause'), null)
    assert.deepEqual(
      buildDonationFundingClaim('x', { handle: '@MyHandle' }),
      { mode: 'x', params: { handle: 'myhandle' } },
    )
    assert.equal(buildDonationFundingClaim('x', { handle: '$$$' }), null)
    assert.equal(buildIdeaFundingClaim('tbd'), 'tbd')
    assert.equal(buildIdeaFundingClaim('realms'), 'realms')
    assert.deepEqual(buildIdeaFundingClaim('direct', { address: PAYER }), {
      mode: 'direct',
      address: PAYER,
    })
    assert.equal(buildIdeaFundingClaim('direct', { address: 'bad' }), null)
    assert.equal(buildIdeaFundingClaim('x', { handle: 'too_long_handle_over_15' }), null)
  })

  it('mode lists match the app launchable sets', () => {
    assert.deepEqual(causeFundingLaunchModes(null), ['managed', 'cause', 'project'])
    assert.deepEqual(ideaFundingLaunchModes(null), ['direct', 'tbd'])
    const causeModes = causeFundingLaunchModes([
      { mode: 'managed', status: 'active', pickers: ['launch'], isFinal: true, launchEnabled: true },
      { mode: 'tbd', status: 'active', pickers: ['launch'], isFinal: false, launchEnabled: true },
      { mode: 'x', status: 'active', pickers: ['launch'], isFinal: false, launchEnabled: false },
    ])
    assert.deepEqual(causeModes, ['managed', 'tbd'])
    const ideaModes = ideaFundingLaunchModes([
      { mode: 'managed', status: 'active', pickers: ['launch'], isFinal: true },
      { mode: 'tbd', status: 'active', pickers: ['launch'], isFinal: false },
      { mode: 'direct', status: 'active', pickers: ['launch'], isFinal: true },
    ])
    assert.deepEqual(ideaModes, ['tbd', 'direct']) // managed withheld by owner decision
  })

  it('first-buy amount parser matches the app grammar', () => {
    assert.equal(canonicalFirstBuyAmount('0,5'), '0.5')
    assert.equal(canonicalFirstBuyAmount(',5'), '0.5')
    assert.equal(canonicalFirstBuyAmount('.5'), '0.5')
    assert.equal(canonicalFirstBuyAmount('1,000'), null) // ambiguous — refused
    assert.equal(canonicalFirstBuyAmount('1,000.5'), '1000.5')
    assert.equal(canonicalFirstBuyAmount('-1'), null)
    assert.equal(parseFirstBuyUiAmount('1.5', 6), 1500000n)
    assert.equal(parseFirstBuyUiAmount('1.5', 9), 1500000000n)
    assert.equal(parseFirstBuyUiAmount('0', 6), 0n)
    assert.equal(parseFirstBuyUiAmount('', 6), 0n)
    // multiplier 2/1 → display atoms ÷ 2 (floor)
    assert.equal(
      parseFirstBuyUiAmount('10', 6, { numerator: 2n, denominator: 1n }),
      5000000n,
    )
    // multiplier 1.5 → ÷ 3/2 = × 2/3
    assert.equal(
      parseFirstBuyUiAmount('9', 6, { numerator: 3n, denominator: 2n }),
      6000000n,
    )
  })
})
