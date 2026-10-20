/**
 * TB-D-1 criterion 3 (consumer side): every config key this service names as
 * a launch config is compared to the vendored dbc-config record
 * (tests/fixtures/config-record.json). No test reads a sibling repo or the
 * chain. A mismatch fails; it is never a warning.
 *
 * Compared: DEFAULT_DBC_CONFIG_KEY, public/skill.json, public/v2/skill.json,
 * SKILL.md / SKILL.v1.md, the captured mobile-config fixture, and the static
 * quote-asset facts config-catalog.ts / config.ts carry (the catalog's config
 * keys themselves are served by the backend at runtime).
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_DBC_CONFIG_KEY, DBC_PROGRAM_ID, KNOWN_MINTS } from '../src/lib/config.ts'
import { resolveQuoteAssetRecord } from '../src/lib/config-catalog.ts'
import { configRecord, mobileConfigFixture, type ConfigRecordKey } from './helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const RECORD_COMMIT = '1942b7ca7697b01de4296423c881a2af1c5b7af5'
const RECORD_SHA256 = '3908692975dd5a7f40e2b45011a6db485d019e9d90f44bab65257456c3357aa1'

const BASE58_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
const BASE58_ELLIPSIS = /\b[1-9A-HJ-NP-Za-km-z]{8,12}…/g
const NATIVE_MINT = 'So11111111111111111111111111111111111111112'

const record = configRecord()
const byKey = new Map(record.keys.map((k) => [k.key, k]))
const productionKeys = record.keys.filter((k) => k.role === 'production')
const recordDefault = record.keys.filter((k) => k.default)

/** Addresses that are legitimately not launch configs (program ids, quote mints). */
const NON_CONFIG_ADDRESSES = new Set<string>([
  record.dbcProgramId,
  NATIVE_MINT,
  ...record.productionQuoteAllowlist.flatMap((q) => [q.mint, q.tokenProgram]),
  // Well-known Solana program ids named by the TB-S-3 review-before-signing
  // sections (SKILL.md, SKILL.v1.md, both skill.json) — programs, not configs.
  '11111111111111111111111111111111', // System Program
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  // Token-2022 is named by the review sections but is not in the record's
  // production quote allowlist (every production quote mint is SPL Token).
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  // DAMM v2 (cp-amm): emitted by `claim_fees` with `source: "position"`.
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
])

/** Assert `key` is a production config in the record (the default, when `asDefault`). */
function assertProduction(key: string, where: string, asDefault = false): ConfigRecordKey {
  const entry = byKey.get(key)
  assert.ok(entry, `${where}: config key ${key} is absent from the vendored dbc-config record`)
  assert.equal(entry.role, 'production', `${where}: ${key} has role "${entry.role}" in the record, expected production`)
  if (asDefault) assert.equal(entry.default, true, `${where}: ${key} is not the record's default`)
  return entry
}

/** Every config-key mention in a document: full addresses not known as non-configs, and `abcd1234…` prefixes. */
function namedConfigKeys(text: string, where: string): Set<string> {
  const keys = new Set<string>()
  for (const addr of text.match(BASE58_ADDRESS) ?? []) {
    if (!NON_CONFIG_ADDRESSES.has(addr)) keys.add(addr)
  }
  for (const m of text.match(BASE58_ELLIPSIS) ?? []) {
    const prefix = m.slice(0, -1)
    if ([...NON_CONFIG_ADDRESSES].some((a) => a.startsWith(prefix))) continue
    const hits = record.keys.filter((k) => k.key.startsWith(prefix))
    // An ellipsis token is a key mention if it prefixes a record key (any
    // role, so a retired key still fails) or looks like an address
    // (contains a digit); plain prose words ("response…") are skipped.
    if (hits.length === 0 && !/\d/.test(prefix)) continue
    assert.equal(hits.length, 1, `${where}: truncated key "${m}" matches ${hits.length} record keys`)
    keys.add(hits[0].key)
  }
  return keys
}

describe('vendored dbc-config record', () => {
  it('is byte-for-byte the pinned record', () => {
    const sha = createHash('sha256').update(readFileSync(join(ROOT, 'tests/fixtures/config-record.json'))).digest('hex')
    assert.equal(sha, RECORD_SHA256, `tests/fixtures/config-record.json differs from dbc-config@${RECORD_COMMIT}`)
  })

  it('has exactly one production default and it is indexed', () => {
    assert.equal(recordDefault.length, 1)
    assert.equal(recordDefault[0].role, 'production')
    assert.equal(recordDefault[0].indexed, true)
  })
})

describe('DEFAULT_DBC_CONFIG_KEY vs record', () => {
  it('is the record production default', () => {
    assertProduction(DEFAULT_DBC_CONFIG_KEY, 'DEFAULT_DBC_CONFIG_KEY', true)
    assert.equal(DEFAULT_DBC_CONFIG_KEY, recordDefault[0].key)
  })

  it('DBC program id matches the record', () => {
    assert.equal(DBC_PROGRAM_ID, record.dbcProgramId)
  })
})

describe('skill documents vs record', () => {
  const docs = ['SKILL.md', 'SKILL.v1.md', 'public/skill.json', 'public/v2/skill.json']
  for (const doc of docs) {
    it(`${doc}: every named config key is a production key in the record, and the default one is named`, () => {
      const named = namedConfigKeys(read(doc), doc)
      assert.ok(named.size > 0, `${doc} names no config key`)
      for (const key of named) assertProduction(key, doc)
      // These documents describe the v1/omitted-configKey default; it must be the record default.
      assert.ok(named.has(recordDefault[0].key), `${doc} does not name the record default ${recordDefault[0].key}`)
    })
  }

  it('the skill.json v1 `poolConfig` field is the record default', () => {
    const json = JSON.parse(read('public/skill.json')) as Record<string, unknown>
    const found: string[] = []
    const walk = (v: unknown) => {
      if (typeof v === 'string' && byKey.has(v)) found.push(v)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(json)
    assert.ok(found.length > 0)
    for (const key of found) assertProduction(key, 'public/skill.json', true)
  })
})

describe('mobile-config fixture vs record', () => {
  const mc = mobileConfigFixture()
  it('every served launch key is a production key the production backend indexes', () => {
    const served = new Set<string>(Object.values(mc.launchConfigKeys ?? {}) as string[])
    for (const refs of Object.values(mc.launchConfigOptions ?? {})) {
      for (const ref of (refs ?? []) as { configKey: string; quoteMint: string }[]) {
        served.add(ref.configKey)
        const entry = assertProduction(ref.configKey, 'mobile-config.web.json launchConfigOptions')
        assert.equal(entry.indexed, true, `${ref.configKey} is served but the record says it is not indexed`)
        assert.equal(ref.quoteMint, entry.quoteMint, `${ref.configKey} quoteMint differs from the record`)
      }
    }
    assert.ok(served.size > 0)
    for (const key of served) assertProduction(key, 'mobile-config.web.json launchConfigKeys')
  })

  it('served quote assets and primaryQuote are in the record allowlist with identical facts', () => {
    const allow = new Map(record.productionQuoteAllowlist.map((q) => [q.mint, q]))
    for (const q of [...((mc.quoteAssets ?? []) as unknown[]), mc.primaryQuote].filter(Boolean) as { mint: string; symbol: string; decimals: number; tokenProgram: string }[]) {
      assert.deepEqual(
        { mint: q.mint, symbol: q.symbol, decimals: q.decimals, tokenProgram: q.tokenProgram },
        allow.get(q.mint),
        `mobile-config quote asset ${q.mint} differs from the record allowlist`,
      )
    }
  })
})

describe('static quote facts in config.ts / config-catalog.ts vs record', () => {
  it('built-in SKR and USDC registry entries equal the record allowlist', () => {
    for (const q of record.productionQuoteAllowlist) {
      const built = resolveQuoteAssetRecord(q.mint)
      assert.ok(built, `config-catalog.ts has no built-in quote asset for ${q.symbol} ${q.mint}`)
      assert.deepEqual(
        { mint: built.mint, symbol: built.symbol, decimals: built.decimals, tokenProgram: built.tokenProgram },
        q,
      )
    }
  })

  it('KNOWN_MINTS entries that are record quote mints agree on symbol and decimals', () => {
    for (const q of record.productionQuoteAllowlist) {
      const known = KNOWN_MINTS[q.mint]
      if (known) assert.deepEqual(known, { symbol: q.symbol, decimals: q.decimals })
    }
    assert.ok(KNOWN_MINTS[record.productionQuoteAllowlist.find((q) => q.symbol === 'USDC')!.mint])
  })

  it('the default key quote mint resolves to a built-in with the recorded decimals', () => {
    const d = recordDefault[0]
    assert.equal(resolveQuoteAssetRecord(d.quoteMint)?.decimals, d.quoteDecimals)
  })
})
