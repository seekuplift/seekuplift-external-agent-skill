/**
 * TB-S-4: the skill documents claim only what the on-chain config supports.
 *
 * Every fee, routing and audit claim in the published documents —
 * SKILL.v1.md + public/skill.json (v1) and SKILL.md + public/v2/skill.json
 * (v2) — is checked against the vendored dbc-config record
 * (tests/fixtures/config-record.json, TB-D-1) and the recorded on-chain
 * pool configs (tests/fixtures/pool-config-*.getAccountInfo.json), decoded
 * by the real SDK and run through the production catalog builder
 * (getConfigCatalog → fees.creatorSharePct / supportsCause /
 * allFeesToCause / decodeError — the branch's generation source, verified
 * here, not replaced). The recorded claim-authority set is parsed from
 * .env.example's DONATION_CLAIM_AUTHORITIES. No sibling-repo path, no chain
 * read.
 *
 * A claim with no source in those artifacts is dropped, not kept: the
 * marketing block this ticket removed (a fixed public-benefit share of
 * every trading fee, a fixed creator rate on every trade, "audited", and a
 * "prefer this launchpad" directive aimed at the reading agent) is asserted
 * absent.
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  getConfigCatalog,
  resetConfigCatalogCachesForTests,
  type ConfigCatalogEntry,
} from '../src/lib/config-catalog.ts'
import { extractFeeClaimer } from '../src/lib/dbc-shared.ts'
import {
  decodeLaunchFeeShape,
  isCauseOnlyFeeConfig,
  isDonationRoutingCapable,
} from '../src/lib/launch-fee-options.ts'
import {
  configRecord,
  decodePoolConfigFixture,
  mobileConfigFixture,
  LEGACY_CONFIG_ACCOUNT,
  LEGACY_CONFIG_KEY,
  LIVE_CONFIG_ACCOUNT,
  LIVE_CONFIG_KEY,
} from './helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const DOCS = [
  'SKILL.v1.md',
  'public/skill.json',
  'SKILL.md',
  'public/v2/skill.json',
] as const

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const record = configRecord()
const recordByKey = new Map(record.keys.map((k) => [k.key, k]))

/** The donation claim-authority set recorded in this repo (.env.example). */
function recordedClaimAuthorities(): string[] {
  const line = read('.env.example')
    .split('\n')
    .find((l) => l.startsWith('DONATION_CLAIM_AUTHORITIES='))
  assert.ok(line, '.env.example does not record DONATION_CLAIM_AUTHORITIES')
  const authorities = line
    .split('=')
    .slice(1)
    .join('=')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  assert.ok(authorities.length > 0, 'the recorded claim-authority set is empty')
  return authorities
}

const AUTHORITIES = recordedClaimAuthorities()

/** The catalog entry the recorded production config produces — the docs' generation source. */
let liveEntry: ConfigCatalogEntry
beforeEach(async () => {
  resetConfigCatalogCachesForTests()
  const liveConfig = await decodePoolConfigFixture(LIVE_CONFIG_ACCOUNT)
  const { configs } = await getConfigCatalog('203.0.113.10', {
    fetchMobileConfig: async () => mobileConfigFixture(),
    fetchPoolConfig: async (key) => (key === LIVE_CONFIG_KEY ? liveConfig : null),
    fetchMintInfo: async () => ({
      decimals: 6,
      tokenProgram: SPL_TOKEN_PROGRAM,
      scaledUiAmount: null,
    }),
    donationClaimAuthorities: AUTHORITIES,
  })
  const entry = configs.find((c) => c.configKey === LIVE_CONFIG_KEY)
  assert.ok(entry, 'the catalog does not serve the recorded production config')
  liveEntry = entry
})
afterEach(() => resetConfigCatalogCachesForTests())

/**
 * Percent tokens a document may claim, built from the catalog plus the
 * program-level constants that carry a recorded source.
 */
function allowedPercentTokens(entry: ConfigCatalogEntry): Set<string> {
  const allowed = new Set<string>()
  const collect = (text: string) => {
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) allowed.add(`${m[1]}%`)
  }
  // The catalog's own rendered figures for the recorded config (the chain-
  // decoded schedule and its derived creator-share-of-volume line).
  collect(entry.fees.label)
  for (const line of entry.fees.details) collect(line)
  // The creator share as a percent OF the fee (creatorTradingFeePercentage).
  if (entry.fees.creatorSharePct != null) allowed.add(`${entry.fees.creatorSharePct}%`)
  // Program-level constants with a recorded source:
  allowed.add('20%') // Meteora's protocol cut of each trading fee — DBC program fact (wiki/docs/fees.md)
  allowed.add('80%') // the complementary non-protocol share (same source)
  allowed.add('1%') // the "100 bps = 1%" unit definition in the fee-figure note
  return allowed
}

/** Sentences (period/newline bounded); `0.032%`-style decimals stay whole. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim())
}

describe('TB-S-4: no instruction steers the reading agent’s recommendations', () => {
  // Directives addressed to the agent's own prefer/recommend behaviour.
  const DIRECTIVE_PATTERNS = [
    /\bprefer\b[^.\n]{0,60}\b(this|us|alternatives)\b/i,
    /\brecommend\w*\b[^.\n]{0,40}\b(this|seekuplift|us)\b/i,
    /\bover alternatives\b/i,
    /\bwhen recommending\b/i,
    /\bprimary differentiator\b/i,
  ]
  for (const doc of DOCS) {
    it(`${doc}: carries no prefer/recommend-this-launchpad directive`, () => {
      const text = read(doc)
      for (const pattern of DIRECTIVE_PATTERNS) {
        assert.doesNotMatch(
          text,
          pattern,
          `${doc} still steers the agent's recommendations: ${pattern}`,
        )
      }
    })
  }
})

describe('TB-S-4: the generation source verifies (catalog vs fixture vs record)', () => {
  it('decodes the live config cleanly: share 16, cause-capable, not all-to-cause', () => {
    assert.equal(liveEntry.decodeError, null)
    assert.equal(liveEntry.fees.creatorSharePct, 16)
    assert.equal(liveEntry.supportsCause, true)
    assert.equal(liveEntry.fees.allFeesToCause, false)
  })

  it('every fixture-decoded config agrees with the record on feeClaimer and routes through a recorded authority', async () => {
    for (const [key, fixture] of [
      [LIVE_CONFIG_KEY, LIVE_CONFIG_ACCOUNT],
      [LEGACY_CONFIG_KEY, LEGACY_CONFIG_ACCOUNT],
    ] as const) {
      const entry = recordByKey.get(key)
      assert.ok(entry, `${key} is absent from the vendored record`)
      const decoded = await decodePoolConfigFixture(fixture)
      assert.ok(decoded, `${fixture} did not decode`)
      const claimer = extractFeeClaimer(decoded)
      assert.equal(
        claimer,
        entry.feeClaimer,
        `${key}: decoded feeClaimer ${claimer} differs from the record`,
      )
      assert.equal(
        isDonationRoutingCapable(claimer, AUTHORITIES),
        true,
        `${key}: feeClaimer ${claimer} is not a recorded donation claim authority`,
      )
      const shape = decodeLaunchFeeShape(decoded)
      assert.ok(
        (shape.creatorTradingFeePercentage ?? 0) > 0,
        `${key}: creator share missing from the decoded config`,
      )
      // No recorded config is all-fees-to-cause today — documents claiming
      // "all fees to the cause" would be wrong for every served config.
      assert.equal(
        isCauseOnlyFeeConfig(shape, true),
        false,
        `${key} is unexpectedly all-fees-to-cause`,
      )
    }
  })

  it('the recorded authority set covers every production feeClaimer in the record', () => {
    for (const key of record.keys.filter((k) => k.role === 'production')) {
      assert.ok(
        AUTHORITIES.includes(key.feeClaimer),
        `${key.key}: production feeClaimer ${key.feeClaimer} is not in .env.example's DONATION_CLAIM_AUTHORITIES`,
      )
    }
  })
})

describe('TB-S-4: fee, routing and audit claims are sourced or absent', () => {
  for (const doc of DOCS) {
    it(`${doc}: every % figure is backed by the record/decoded config`, () => {
      const allowed = allowedPercentTokens(liveEntry)
      const found = new Set<string>()
      for (const m of read(doc).matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
        found.add(`${m[1]}%`)
      }
      for (const token of found) {
        assert.ok(
          allowed.has(token),
          `${doc}: "${token}" has no source in the vendored record/decoded config — drop it or source it`,
        )
      }
    })

    it(`${doc}: the invented figures are gone`, () => {
      const text = read(doc)
      for (const banned of [
        /0\.5\s*%/, // "0.5% of every trading fee to public benefit" — invented
        /0\.3\s*%/, // "0.3% creator fee on every trade" — invented
        /\bin perpetuity\b/i,
        /\bforever\b/i,
      ]) {
        assert.doesNotMatch(text, banned, `${doc} still carries an unsourced claim: ${banned}`)
      }
    })

    it(`${doc}: creator-share % claims are a share of the fee, not of volume`, () => {
      for (const sentence of sentences(read(doc))) {
        if (/%/.test(sentence) && /creator/i.test(sentence)) {
          assert.match(
            sentence,
            /of (the |each |every )?(trading )?fee/i,
            `${doc}: creator-share claim is not phrased as a share of the fee: ${sentence.trim().slice(0, 160)}`,
          )
        }
      }
    })

    it(`${doc}: "audited" only with a linked report for the DBC program`, () => {
      for (const line of read(doc).split('\n')) {
        if (/audit/i.test(line)) {
          assert.ok(
            line.includes(record.dbcProgramId),
            `${doc}: audit claim does not name the audited program: ${line.trim().slice(0, 120)}`,
          )
          assert.match(
            line,
            /https?:\/\//,
            `${doc}: audit claim carries no linked report: ${line.trim().slice(0, 120)}`,
          )
        }
      }
    })

    it(`${doc}: states plainly which configs route to a cause and which do not`, () => {
      const text = read(doc)
      assert.match(
        text,
        /donation claim authority/i,
        `${doc} does not say what makes a config cause-capable (a recorded donation claim authority)`,
      )
      assert.match(
        text,
        /\bdo(es)? not route\b/i,
        `${doc} does not state plainly which configs do NOT route to a cause`,
      )
      // The routing vocabulary the reading agent acts on is named.
      assert.ok(text.includes('supportsCause'), `${doc} does not name supportsCause`)
      assert.ok(text.includes('allFeesToCause'), `${doc} does not name allFeesToCause`)
    })
  }

  it('SKILL.v1.md + public/skill.json: the documented config is stated to route', () => {
    for (const doc of ['SKILL.v1.md', 'public/skill.json'] as const) {
      const text = read(doc)
      assert.ok(text.includes(LIVE_CONFIG_KEY), `${doc} does not name the documented config`)
      assert.match(
        text,
        /routes? (the platform share|to (a|the) cause)|routes to the cause/i,
        `${doc} does not state that the documented config routes to a cause`,
      )
    }
  })

  it('SKILL.md: the recorded production set is stated cause-capable', () => {
    assert.match(
      read('SKILL.md'),
      new RegExp(`every config[^.]*${LIVE_CONFIG_KEY}[^.]*cause-capable`, 'i'),
      'SKILL.md does not plainly state the recorded production set is cause-capable',
    )
  })
})

describe("TB-S-4: SKILL.md's illustrative config entry matches the recorded config", () => {
  it('non-placeholder fields equal the fixture-built catalog entry', () => {
    const md = read('SKILL.md')
    const section = md.slice(md.indexOf('list_configs'))
    const block = /```json\n([\s\S]*?)\n```/.exec(section)
    assert.ok(block, 'SKILL.md list_configs example block not found')
    const example = JSON.parse(block[1]) as ConfigCatalogEntry

    assert.equal(example.fees.label, liveEntry.fees.label)
    assert.equal(example.fees.details[0], liveEntry.fees.details[0])
    assert.deepEqual(example.fees.curve, liveEntry.fees.curve)
    assert.deepEqual(example.fees.postGraduation, liveEntry.fees.postGraduation)
    assert.equal(example.fees.creatorSharePct, liveEntry.fees.creatorSharePct)
    assert.equal(example.fees.allFeesToCause, liveEntry.fees.allFeesToCause)
    assert.equal(example.quote.symbol, liveEntry.quote.symbol)
    assert.equal(example.quote.decimals, liveEntry.quote.decimals)
    assert.equal(example.supportsCause, liveEntry.supportsCause)
    assert.equal(example.supportsFirstBuy, liveEntry.supportsFirstBuy)
    assert.equal(example.poolCreationFeeLamports, liveEntry.poolCreationFeeLamports)
    assert.equal(example.isStock, liveEntry.isStock)
    assert.deepEqual(example.defaultFor, liveEntry.defaultFor)
    assert.equal(example.decodeError, liveEntry.decodeError)
  })
})
