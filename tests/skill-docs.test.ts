/**
 * DD-S-1 skill-document agreement tests.
 *
 * The public contract ships as two documents per version — SKILL.*.md and
 * skill.json — hand-maintained in parallel. This file pins them to each
 * other and to the one source constant for the production config:
 *
 *   - every endpoint, field name and fee claim in skill.json appears in the
 *     matching SKILL.*.md (and every capability endpoint the markdown
 *     documents is a json capability endpoint);
 *   - the default config key, the pools filter's served keys and the
 *     documents all name DEFAULT_DBC_CONFIG_KEY;
 *   - the v1 sunset date is stated in both versions' docs + the changelog.
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_DBC_CONFIG_KEY, V1_CONTRACT_SUNSET } from '../src/lib/config.ts'
import { catalogConfigKeys } from '../src/lib/pools.ts'
import { parseLaunchConfigOptions } from '../src/lib/config-catalog.ts'
import { mobileConfigFixture } from './helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const readJson = (rel: string) => JSON.parse(read(rel))

const V1_MD = () => read('SKILL.v1.md')
const V2_MD = () => read('SKILL.md')
const V1_JSON = () => readJson('public/skill.json')
const V2_JSON = () => readJson('public/v2/skill.json')
const CHANGELOG = () => read('CHANGELOG.md')

/** Expand "a.{b,c}" groups and "x|y" alternatives into bare field names. */
function* fieldNames(spec: string): Generator<string> {
  const brace = /\{([^}]*)\}/.exec(spec)
  if (brace) {
    for (const part of brace[1].split(',')) {
      const name = part.trim()
      if (name) yield name
    }
    const rest = spec.slice(brace.index + brace[0].length).replace(/^\.+/, '')
    if (rest) yield* fieldNames(rest)
    return
  }
  for (const alt of spec.split('|')) {
    const name = alt.trim()
    if (name) yield name
  }
}

/** Every field name a capability object declares, normalized to bare names. */
function capabilityFieldNames(cap: Record<string, unknown>): string[] {
  const names = new Set<string>()
  const fromList = (value: unknown) => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') for (const name of fieldNames(item)) names.add(name)
    }
  }
  const fromKeys = (value: unknown) => {
    if (Array.isArray(value)) fromList(value)
    else if (value && typeof value === 'object') {
      // Object form: the KEYS are the field names; the values are prose.
      for (const key of Object.keys(value)) names.add(key)
    }
  }
  for (const key of [
    'requiredFields',
    'optionalFields',
    'returns',
    'poolFields',
    'poolInfoFields',
    'configEntryFields',
  ]) {
    fromList(cap[key])
  }
  for (const key of ['queryParams', 'fieldNotes']) {
    fromKeys(cap[key])
  }
  return [...names]
}

/** Percentage fee claims anywhere in the json (e.g. "0.5%", "20%"). */
function feeClaimPercents(json: unknown): string[] {
  const found = new Set<string>()
  for (const m of JSON.stringify(json).matchAll(/\d+(?:\.\d+)?\s*%/g)) {
    found.add(m[0].replace(/\s+/g, ''))
  }
  return [...found]
}

/** `/api/...` paths the markdown mentions, minus backend-owned references. */
function mdApiPaths(md: string): string[] {
  const found = new Set<string>()
  for (const m of md.matchAll(/\/api\/[a-z0-9/_-]+/gi)) {
    const path = m[0].replace(/[.,;:)\]`]*$/, '')
    found.add(path)
  }
  // Backend-owned paths the docs reference in prose — they are NOT skill
  // capabilities (the backend's upload proxy, cause picker, stream surface).
  for (const internal of ['/api/upload', '/api/causes', '/api/stream', '/api/mobile-config', '/api/cause-funding', '/api/idea-funding']) {
    for (const path of [...found]) {
      if (path === internal || path.startsWith(`${internal}/`)) found.delete(path)
    }
  }
  return [...found]
}

function assertJsonCoveredByMd(json: Record<string, unknown>, md: string, label: string) {
  const endpointPaths = new Set<string>()
  const caps = (json.capabilities ?? []) as Record<string, unknown>[]
  assert.ok(caps.length > 0, `${label}: no capabilities`)
  for (const cap of caps) {
    const id = cap.id as string
    const endpoint = cap.endpoint as { method: string; path: string }
    assert.ok(endpoint?.path, `${label}: capability ${id} has no endpoint`)
    endpointPaths.add(endpoint.path)
    assert.ok(
      md.includes(endpoint.path),
      `${label}: SKILL.md does not document ${cap.id}'s endpoint ${endpoint.path}`,
    )
    assert.ok(
      md.includes(endpoint.method),
      `${label}: SKILL.md does not mention method ${endpoint.method}`,
    )
    assert.ok(md.includes(id), `${label}: SKILL.md does not name capability ${id}`)
    for (const field of capabilityFieldNames(cap)) {
      assert.ok(
        md.includes(field),
        `${label}: field "${field}" (${id}) missing from SKILL.md`,
      )
    }
  }
  for (const pct of feeClaimPercents(json)) {
    assert.ok(md.includes(pct), `${label}: fee claim "${pct}" missing from SKILL.md`)
  }
  // The other direction: every capability endpoint the markdown documents
  // is a json capability endpoint. A trailing `/*` is a wildcard reference
  // ("trade via /api/trade/*") — satisfied when an endpoint has the prefix.
  for (const path of mdApiPaths(md)) {
    const covered = path.endsWith('*') || path.endsWith('/')
      ? [...endpointPaths].some((p) => p.startsWith(path.replace(/\*+$/, '').replace(/\/+$/, '/') ))
      : endpointPaths.has(path)
    assert.ok(covered, `${label}: SKILL.md documents ${path} but skill.json has no such endpoint`)
  }
}

describe('skill.json ↔ SKILL.md agreement (each version)', () => {
  it('v1: every endpoint, field and fee claim agrees', () => {
    assertJsonCoveredByMd(V1_JSON(), V1_MD(), 'v1')
  })

  it('v2: every endpoint, field and fee claim agrees', () => {
    assertJsonCoveredByMd(V2_JSON(), V2_MD(), 'v2')
  })
})

describe('the prod-indexed config key — one source constant', () => {
  it('DEFAULT_DBC_CONFIG_KEY is the production-indexed config', () => {
    assert.equal(DEFAULT_DBC_CONFIG_KEY, '61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv')
  })

  it('both v1 skill documents name it (poolConfig / Pool Config)', () => {
    assert.equal(V1_JSON().poolConfig, DEFAULT_DBC_CONFIG_KEY)
    assert.ok(V1_MD().includes(DEFAULT_DBC_CONFIG_KEY))
  })

  it('the v2 documents name it as the v1-launch default', () => {
    assert.ok(V2_MD().includes(DEFAULT_DBC_CONFIG_KEY))
    assert.ok(JSON.stringify(V2_JSON()).includes(DEFAULT_DBC_CONFIG_KEY))
  })

  it('the pools filter serves it (catalog keys from the recorded mobile-config)', () => {
    const keys = catalogConfigKeys(parseLaunchConfigOptions(mobileConfigFixture()))
    assert.ok(keys.includes(DEFAULT_DBC_CONFIG_KEY), `pools filter keys ${keys} miss the default`)
  })
})

describe('versioning + sunset', () => {
  it('the sunset date is stated in both versions of both documents and the changelog', () => {
    for (const [label, text] of [
      ['v1 md', V1_MD()],
      ['v2 md', V2_MD()],
      ['v1 json', JSON.stringify(V1_JSON())],
      ['v2 json', JSON.stringify(V2_JSON())],
      ['CHANGELOG', CHANGELOG()],
    ] as const) {
      assert.ok(text.includes(V1_CONTRACT_SUNSET), `${label} does not state the ${V1_CONTRACT_SUNSET} sunset`)
    }
  })

  it('v1 docs declare version 1.x + the v2 pointer; v2 docs declare 2.x + the v1 paths', () => {
    const v1 = V1_JSON()
    assert.match(v1.version, /^1\./)
    assert.equal(v1.status, 'deprecated')
    assert.equal(v1.sunset, V1_CONTRACT_SUNSET)
    assert.equal(v1.successor.json, '/v2/skill.json')
    const v2 = V2_JSON()
    assert.match(v2.version, /^2\./)
    assert.equal(v2.docs.markdown, '/v2/skill.md')
    assert.equal(v2.docs.v1.sunset, V1_CONTRACT_SUNSET)
    assert.equal(v2.docs.v1.markdown, '/skill.md')
    assert.ok(V1_MD().includes('/v2/skill.md'), 'v1 md does not point at v2')
    assert.ok(V2_MD().includes('/skill.md'), 'v2 md does not name the v1 path')
  })

  it('the changelog lists the v1↔v2 field differences', () => {
    const changelog = CHANGELOG()
    for (const token of ['buyAmountSol', 'firstBuyAtoms', 'configKey', 'category', 'unsupported_buyAmountSol', DEFAULT_DBC_CONFIG_KEY]) {
      assert.ok(changelog.includes(token), `CHANGELOG.md does not mention ${token}`)
    }
  })
})

/** The exact program ids the builders can emit — the signing-review list. */
const BUILDER_PROGRAM_IDS = [
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
]

describe('TB-S-3: signing review + auth in the contract documents', () => {
  it('SKILL.md (v2) carries the review-before-signing section with every program id', () => {
    const md = V2_MD()
    assert.match(md, /Review before signing/)
    assert.match(md, /simulateTransaction\(tx, \{ sigVerify: false \}\)/)
    assert.match(md, /tx\.feePayer/)
    for (const id of BUILDER_PROGRAM_IDS) {
      assert.ok(md.includes(id), `SKILL.md does not list program id ${id}`)
    }
  })

  it('public/v2/skill.json carries the same review instructions and program ids', () => {
    const json = JSON.stringify(V2_JSON())
    assert.ok(json.includes('reviewBeforeSigning'))
    assert.ok(json.includes('sigVerify'))
    assert.ok(json.includes('feePayer'))
    for (const id of BUILDER_PROGRAM_IDS) {
      assert.ok(json.includes(id), `skill.json does not list program id ${id}`)
    }
  })

  it('both v2 documents state the API-key requirement and pinned https origin', () => {
    const md = V2_MD()
    const json = JSON.stringify(V2_JSON())
    for (const text of [md, json]) {
      assert.ok(text.includes('X-Api-Key'), 'missing X-Api-Key')
      assert.ok(text.includes('unauthorized'), 'missing the 401 shape')
      assert.ok(text.includes('rate_limited'), 'missing the 429 shape')
      assert.ok(text.includes('https://skill.seekuplift.com'), 'missing the pinned origin')
    }
  })

  it('the frozen v1 documents carry the same service-level changes (unversioned endpoints)', () => {
    const md = V1_MD()
    const json = JSON.stringify(V1_JSON())
    for (const text of [md, json]) {
      assert.ok(text.includes('X-Api-Key'), 'v1 doc does not state the key requirement')
      assert.ok(text.includes('min_out_below_floor'), 'v1 doc does not state the floor')
    }
  })
})
