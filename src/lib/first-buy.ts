/**
 * First-buy amount parsing — ported from the app's
 * src/domain/trade-flow.ts (`parseTradeAmountInput`/`canonicalTradeAmount`)
 * and src/domain/launch-flow.ts (`canonicalFirstBuyAmount`,
 * `parseFirstBuyUiAmount`).
 *
 * The display-unit entry converts to raw quote atoms by scaling by
 * 10^decimals then FLOOR-dividing by the quote mint's active ScaledUiAmount
 * multiplier (SPL Token `uiAmountToAmount` semantics). A null/absent
 * multiplier is 1 — SKR/SOL and every unscaled mint take the unchanged path.
 * The old `* 1e9` assumption is gone.
 */
import {
  IDENTITY_SCALED_UI_MULTIPLIER,
  type ScaledUiMultiplier,
} from './dbc-shared.ts'

export type TradeAmountParse =
  | { kind: 'empty' }
  | { kind: 'incomplete' }
  | { kind: 'valid'; canonical: string }
  | { kind: 'invalid' }

/** The canonical decimal string for a finished input, or null. */
function canonicalTradeAmount(s: string): string | null {
  const commas = s.split(',').length - 1
  const dots = s.split('.').length - 1
  if (commas === 0 && dots === 0) {
    return /^\d+$/.test(s) ? s : null
  }
  if (dots === 1 && commas === 0) {
    const m = /^(\d*)\.(\d+)$/.exec(s)
    if (!m) return null
    return `${m[1] === '' ? '0' : m[1]}.${m[2]}`
  }
  if (commas === 1 && dots === 0) {
    const m = /^(\d*),(\d+)$/.exec(s)
    if (!m) return null
    const [whole, frac] = [m[1], m[2]]
    // A 1–3 digit head with exactly three digits after the comma is
    // ambiguous between a decimal comma and a thousands group — refuse
    // rather than guess ("1,000" is invalid, not 1000). Four-or-more digits
    // after the comma can only be a fraction, and a head longer than three
    // digits can never be a valid group, so those commas are unambiguous
    // decimals.
    if (whole.length >= 1 && whole.length <= 3 && frac.length === 3) return null
    return `${whole === '' ? '0' : whole}.${frac}`
  }
  if (dots === 1 && commas >= 1) {
    // Commas are thousands groups only before a dot decimal, every group
    // after the head exactly three digits. Any other mixture is refused.
    const m = /^(\d{1,3})((?:,\d{3})+)\.(\d+)$/.exec(s)
    if (!m) return null
    return `${m[1]}${m[2].replace(/,/g, '')}.${m[3]}`
  }
  return null
}

/**
 * Parse raw amount text into a canonical decimal string or a
 * classification. "0,5" → "0.5"; ",5"/".5" → "0.5"; "1,000.5" → "1000.5".
 * Rejected rather than guessed: "1,000"/"12,345", "1,2,3"/"1,000,000",
 * "12,34.5"/"1.000,5", signs, exponents, embedded whitespace and every other
 * character. Outer whitespace is trimmed.
 */
export function parseTradeAmountInput(raw: string): TradeAmountParse {
  const s = raw.trim()
  if (s === '') return { kind: 'empty' }
  if (!/^[0-9.,]+$/.test(s)) return { kind: 'invalid' }
  if (/[.,]$/.test(s)) {
    const core = s.slice(0, -1)
    if (core === '') return { kind: 'incomplete' }
    if (/[.,]$/.test(core)) return { kind: 'invalid' }
    if (canonicalTradeAmount(core) != null || /^\d{1,3}(?:,\d{3})+$/.test(core)) {
      return { kind: 'incomplete' }
    }
    return { kind: 'invalid' }
  }
  const canonical = canonicalTradeAmount(s)
  return canonical != null ? { kind: 'valid', canonical } : { kind: 'invalid' }
}

/**
 * The canonical decimal text for a finished first-buy entry, else null.
 * More fraction digits than the quote mint allows is invalid — the fraction
 * is counted in typed display units; the scaled-UI multiplier never
 * changes it.
 */
export function canonicalFirstBuyAmount(raw: string, quoteDecimals?: number): string | null {
  const parse = parseTradeAmountInput(raw)
  if (parse.kind !== 'valid') return null
  if (quoteDecimals != null && (parse.canonical.split('.')[1] ?? '').length > quoteDecimals) {
    return null
  }
  return parse.canonical
}

/**
 * Parses a display-units amount string to raw atoms for the given decimals.
 * Returns null when the string is not a valid non-negative decimal;
 * 0n for empty / zero input.
 *
 * For a mint carrying a ScaledUiAmount extension the decimal-scaled value
 * is FLOOR-divided by the active `uiMultiplier` before it becomes raw atoms.
 */
export function parseFirstBuyUiAmount(
  amount: string,
  decimals: number,
  uiMultiplier?: ScaledUiMultiplier | null,
): bigint | null {
  if (!amount.trim()) return 0n
  const canonical = canonicalFirstBuyAmount(amount, decimals)
  if (canonical == null) return null
  const [whole, fraction = ''] = canonical.split('.')
  const w = whole || '0'
  const f = fraction.padEnd(decimals, '0').slice(0, decimals)
  try {
    const scaledAtomics = BigInt(`${w}${f}`.replace(/^0+(?=\d)/, '') || '0')
    const m = uiMultiplier ?? IDENTITY_SCALED_UI_MULTIPLIER
    return m.numerator > 0n ? (scaledAtomics * m.denominator) / m.numerator : scaledAtomics
  } catch {
    return null
  }
}

/**
 * A `firstBuyAtoms` request field — a raw quote-atom integer string.
 * Returns the bigint, or null when the text is not a bare unsigned integer.
 */
export function parseFirstBuyAtoms(raw: unknown): bigint | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return BigInt(raw)
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  try {
    return BigInt(trimmed)
  } catch {
    return null
  }
}
