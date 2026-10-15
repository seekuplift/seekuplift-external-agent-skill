/** Geo verdict unit tests — parse + per-category create gate. */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  createFeatureKeys,
  geoBlockedMessage,
  regionDisplayName,
  OPEN_GEO_VERDICT,
  parseGeoVerdict,
  resolveCreateGeo,
} from '../src/lib/geo.ts'

describe('parseGeoVerdict', () => {
  it('fails open on missing/malformed geo', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) {
      assert.deepEqual(parseGeoVerdict(raw), OPEN_GEO_VERDICT)
    }
  })

  it('parses the backend shape and normalizes canonical order', () => {
    const verdict = parseGeoVerdict({
      region: 'US',
      restricted: ['stock.create', 'idea.create', 'cause.marketing', 'unknown.key'],
      betaGated: true,
    })
    assert.equal(verdict.region, 'US')
    assert.deepEqual(verdict.restricted, ['idea.create', 'stock.create', 'cause.marketing'])
    assert.equal(verdict.betaGated, true)
  })
})

describe('createFeatureKeys', () => {
  it('meme uses cause.marketing — there is no meme.create', () => {
    assert.deepEqual(createFeatureKeys('meme', false), ['cause.marketing'])
    assert.deepEqual(createFeatureKeys('meme', true), ['cause.marketing', 'stock.create'])
  })
  it('idea/startup use their own create key', () => {
    assert.deepEqual(createFeatureKeys('idea', false), ['idea.create'])
    assert.deepEqual(createFeatureKeys('startup', true), ['startup.create', 'stock.create'])
  })
})

describe('resolveCreateGeo', () => {
  it('allows when no matching key is restricted; reports the first match', () => {
    const verdict = parseGeoVerdict({
      region: 'US',
      restricted: ['idea.create', 'stock.create'],
    })
    assert.deepEqual(resolveCreateGeo(verdict, 'idea', false), {
      allowed: false,
      reason: 'idea.create',
      region: 'US',
    })
    assert.deepEqual(resolveCreateGeo(verdict, 'meme', false), {
      allowed: true,
      reason: null,
      region: 'US',
    })
    // Stock-quoted meme: cause.marketing not restricted but stock.create is.
    assert.deepEqual(resolveCreateGeo(verdict, 'meme', true), {
      allowed: false,
      reason: 'stock.create',
      region: 'US',
    })
  })

  it('refuses meme launches in a beta-gated region, other categories unaffected', () => {
    const verdict = parseGeoVerdict({ region: 'XX', restricted: [], betaGated: true })
    assert.deepEqual(resolveCreateGeo(verdict, 'meme', false), {
      allowed: false,
      reason: 'beta.gated',
      region: 'XX',
    })
    assert.equal(resolveCreateGeo(verdict, 'idea', false).allowed, true)
  })

  it('names the blocked jurisdiction', () => {
    assert.equal(geoBlockedMessage('gb'), 'This is not currently available in United Kingdom (GB).')
    assert.equal(geoBlockedMessage(null), 'This is not currently available in your detected jurisdiction.')
    assert.equal(regionDisplayName('ZZ'), null)
  })

  it('fails open without a verdict', () => {
    assert.equal(resolveCreateGeo(null, 'idea', true).allowed, true)
  })
})
