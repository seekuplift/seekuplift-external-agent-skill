/**
 * `POST /api/discover` — the interest-matched coin shortlist (CD-S-1).
 *
 * A thin forward to the backend's `POST /api/discover` (spec
 * `backend-rs-sql/docs/superpowers/specs/2026-11-02-coin-discovery-design.md`):
 * the request shape is validated at the edge with the same limits the
 * backend applies, then the body is forwarded unchanged and the backend's
 * ranked response is returned unchanged.
 *
 * The caller IP rides `X-Forwarded-For` so the backend's per-IP discover
 * bucket and the region exclusion (`excludedForRegion`) resolve against
 * the calling agent (colocated deployment — the backend trusts XFF only
 * from loopback).
 *
 * Privacy (spec D4): `interests`/`avoid` are a person's values — never
 * logged, stored or echoed. Validation failures name the failing FIELD
 * only (`{ error: "invalid_request", field, message }` — the backend's
 * own 400 shape), and this module never writes to the console.
 */
import { backendPostJson } from './backend.ts'
import { LaunchError } from './launch.ts'

/** A discover-surface refusal — same body shape the backend's 400s use. */
export class DiscoverError extends LaunchError {
  constructor(field: string, message: string) {
    super(message, 400, { error: 'invalid_request', field, message })
    this.name = 'DiscoverError'
  }
}

// The backend's own limits (src/routes/discover.rs) — kept identical so a
// bad request is refused here the same way the backend would refuse it.
const MAX_INTERESTS_CHARS = 500
const MAX_AVOID_TERMS = 5
const MAX_AVOID_TERM_CHARS = 80
const MAX_CAUSE_SLUGS = 50
const MAX_CURSOR_CHARS = 512
const MAX_LIMIT = 25

const KINDS = new Set(['cause', 'idea', 'any'])
const STAGES = new Set(['curve', 'graduated', 'any'])
const SORTS = new Set(['relevance', 'newest', 'active'])

/** One shortlist entry — the backend's record, passed through unchanged. */
export type DiscoverResult = {
  mint: string | null
  name: string | null
  symbol: string | null
  /** cause | idea | plain. */
  kind: string | null
  /** The cause/project (or idea) this coin funds — nulls for plain coins. */
  funds: { cause: string | null; project: string | null; idea: string | null } | null
  /** USD display-grade figures — never money-path inputs. */
  marketCap: number | null
  volume24h: number | null
  /** curve | graduated. */
  stage: string | null
  /** Relevance 0–1 (before the activity tiebreak). */
  match: number | null
  /** The `interests` piece this coin best matched, e.g. "matches: ocean". */
  why: string | null
}

export type DiscoverResponse = {
  /** semantic = embedding match; keyword = term-match fallback (same shape). */
  mode: 'semantic' | 'keyword'
  results: DiscoverResult[]
  /** Matching coins the caller's region cannot trade, left out of results. */
  excludedForRegion: number
  /** Opaque keyset cursor; null on the last page. */
  nextCursor: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** JS length counts UTF-16 units; spread counts code points like Rust's `chars()`. */
const charCount = (s: string) => [...s].length

/**
 * Validate `body` against the discover request contract and forward it to
 * the backend, returning the shortlist unchanged. Throws `DiscoverError`
 * (400, `invalid_request` naming the field) before any backend call on a
 * bad shape; `BackendHttpError` on a non-2xx backend response.
 */
export async function discover(
  body: unknown,
  clientIp: string | null,
): Promise<DiscoverResponse> {
  if (!isRecord(body)) {
    throw new DiscoverError('body', 'malformed JSON body')
  }

  const interests = body.interests
  if (
    typeof interests !== 'string' ||
    !interests.trim() ||
    charCount(interests.trim()) > MAX_INTERESTS_CHARS
  ) {
    throw new DiscoverError(
      'interests',
      'interests is required (1-500 characters)',
    )
  }

  if (body.avoid !== undefined && body.avoid !== null) {
    if (
      !Array.isArray(body.avoid) ||
      body.avoid.length > MAX_AVOID_TERMS ||
      body.avoid.some(
        (term) =>
          typeof term !== 'string' ||
          charCount(term.trim()) === 0 ||
          charCount(term.trim()) > MAX_AVOID_TERM_CHARS,
      )
    ) {
      throw new DiscoverError('avoid', 'at most 5 avoid terms of 1-80 characters')
    }
  }

  if (body.filters !== undefined && body.filters !== null) {
    if (!isRecord(body.filters)) {
      throw new DiscoverError('filters', 'filters must be an object')
    }
    const { kind, causeSlugs, stage, minVolume24h } = body.filters
    if (kind !== undefined && kind !== null && (typeof kind !== 'string' || !KINDS.has(kind))) {
      throw new DiscoverError('filters.kind', 'kind must be cause|idea|any')
    }
    if (
      causeSlugs !== undefined &&
      causeSlugs !== null &&
      (!Array.isArray(causeSlugs) ||
        causeSlugs.length > MAX_CAUSE_SLUGS ||
        causeSlugs.some((slug) => typeof slug !== 'string'))
    ) {
      throw new DiscoverError('filters.causeSlugs', 'at most 50 cause slugs')
    }
    if (stage !== undefined && stage !== null && (typeof stage !== 'string' || !STAGES.has(stage))) {
      throw new DiscoverError('filters.stage', 'stage must be curve|graduated|any')
    }
    if (
      minVolume24h !== undefined &&
      minVolume24h !== null &&
      (typeof minVolume24h !== 'number' || !Number.isFinite(minVolume24h) || minVolume24h < 0)
    ) {
      throw new DiscoverError('filters.minVolume24h', 'minVolume24h must be >= 0')
    }
  }

  if (
    body.sort !== undefined &&
    body.sort !== null &&
    (typeof body.sort !== 'string' || !SORTS.has(body.sort))
  ) {
    throw new DiscoverError('sort', 'sort must be relevance|newest|active')
  }

  if (body.limit !== undefined && body.limit !== null) {
    if (typeof body.limit !== 'number' || !Number.isInteger(body.limit)) {
      throw new DiscoverError('limit', 'limit must be 1-25')
    }
    if (body.limit < 1 || body.limit > MAX_LIMIT) {
      throw new DiscoverError('limit', 'limit must be 1-25')
    }
  }

  if (body.cursor !== undefined && body.cursor !== null) {
    if (typeof body.cursor !== 'string' || charCount(body.cursor) > MAX_CURSOR_CHARS) {
      throw new DiscoverError('cursor', 'invalid cursor')
    }
  }

  return backendPostJson<DiscoverResponse>('/api/discover', body, { clientIp })
}
