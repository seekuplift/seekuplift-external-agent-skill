/**
 * DD-S-1 skill-document agreement tests.
 *
 * The public contract ships as two documents — SKILL.md and
 * skill.json — hand-maintained in parallel. This file pins them to each
 * other and to the one source constant for the production config:
 *
 *   - every endpoint, field name and fee claim in skill.json appears in the
 *     SKILL.md (and every capability endpoint the markdown
 *     documents is a json capability endpoint);
 *   - the pools filter's served keys include the fixtures' live config;
 *   - the documents declare contract version 1.0.0 at the unversioned paths.
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { catalogConfigKeys } from '../src/lib/pools.ts'
import { parseLaunchConfigOptions } from '../src/lib/config-catalog.ts'
import { LIVE_CONFIG_KEY, mobileConfigFixture } from './helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const readJson = (rel: string) => JSON.parse(read(rel))

const MD = () => read('SKILL.md')
const JSON_DOC = () => readJson('public/skill.json')
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

describe('skill.json ↔ SKILL.md agreement', () => {
  it('every endpoint, field and fee claim agrees', () => {
    assertJsonCoveredByMd(JSON_DOC(), MD(), 'skill')
  })
})

describe('the prod-indexed config key', () => {
  it('the pools filter serves it (catalog keys from the recorded mobile-config)', () => {
    const keys = catalogConfigKeys(parseLaunchConfigOptions(mobileConfigFixture()))
    assert.ok(keys.includes(LIVE_CONFIG_KEY), `pools filter keys ${keys} miss ${LIVE_CONFIG_KEY}`)
  })
})

describe('versioning', () => {
  it('the documents declare 1.0.0 at the unversioned paths and the changelog has the 1.0.0 entry', () => {
    const json = JSON_DOC()
    assert.equal(json.version, '1.0.0')
    assert.equal(json.docs.markdown, '/skill.md')
    assert.equal(json.docs.json, '/skill.json')
    assert.equal(json.docs.changelog, '/CHANGELOG.md')
    assert.ok(MD().includes('**Contract version**: `1.0.0`'), 'SKILL.md does not declare 1.0.0')
    assert.match(CHANGELOG(), /^## 1\.0\.0\b/m)
  })
})

/** The exact program ids the builders can emit — the signing-review list. */
const BUILDER_PROGRAM_IDS = [
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
]

describe('TB-S-3: signing review + auth in the contract documents', () => {
  it('SKILL.md carries the review-before-signing section with every program id', () => {
    const md = MD()
    assert.match(md, /Review before signing/)
    assert.match(md, /simulateTransaction\(tx, \{ sigVerify: false \}\)/)
    assert.match(md, /tx\.feePayer/)
    for (const id of BUILDER_PROGRAM_IDS) {
      assert.ok(md.includes(id), `SKILL.md does not list program id ${id}`)
    }
  })

  it('public/skill.json carries the same review instructions and program ids', () => {
    const json = JSON.stringify(JSON_DOC())
    assert.ok(json.includes('reviewBeforeSigning'))
    assert.ok(json.includes('sigVerify'))
    assert.ok(json.includes('feePayer'))
    for (const id of BUILDER_PROGRAM_IDS) {
      assert.ok(json.includes(id), `skill.json does not list program id ${id}`)
    }
  })

  it('both documents state the API-key requirement and pinned https origin', () => {
    const md = MD()
    const json = JSON.stringify(JSON_DOC())
    for (const text of [md, json]) {
      assert.ok(text.includes('X-Api-Key'), 'missing X-Api-Key')
      assert.ok(text.includes('unauthorized'), 'missing the 401 shape')
      assert.ok(text.includes('rate_limited'), 'missing the 429 shape')
      assert.ok(text.includes('https://skill.seekuplift.com'), 'missing the pinned origin')
    }
  })
})
