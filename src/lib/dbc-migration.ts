/**
 * CA-A-5: the DBC pool's explicit migration state — the shared routing
 * contract — ported verbatim from the app's `src/domain/dbc-migration.ts`.
 *
 * Pinned program `MigrationProgress` (dynamic-bonding-curve
 * `state/virtual_pool.rs`; decoded by SDK 1.5.13 as the pool's
 * `migrationProgress` u8):
 *
 *   0 PreBondingCurve — ordinary curve trading.
 *   1 PostBondingCurve — curve finished; locker step pending (vesting pools).
 *   2 LockedVesting    — curve finished; DAMM pool creation pending.
 *   3 CreatedPool      — terminal; the same migration instruction sets the
 *                        pool's `isMigrated` u8 to 1.
 *
 * The three routing states:
 *
 *  - `"curve"` — the bonding curve still accepts swaps (DBC route).
 *  - `"migration_pending"` — the curve is finished (full reserve or
 *    intermediate progress) but no graduated pool exists yet, OR the
 *    progress bytes cannot be proven. NON-TRADEABLE: routes nowhere — a
 *    DBC swap would revert on-chain (`is_curve_complete` rejects), and
 *    there is no DAMM pool for Jupiter to route to. An ambiguous read
 *    fails closed here: unknown stays pending, never tradeable.
 *  - `"migrated"` — terminal migration proven. The token trades on the
 *    graduated route (Jupiter). The migrated flag wins even with drained
 *    reserves: post-migration the vaults can hold less than the threshold
 *    while the token already trades on the open market.
 */
export type DbcPoolMigrationState = 'curve' | 'migration_pending' | 'migrated'

// Pinned program enum values (see the module doc above). Only terminal
// migration (CreatedPool) may select the graduated route — intermediate
// values are pending, and any value outside the pinned enum is unknown →
// fail closed to pending.
const MIGRATION_PROGRESS_PRE_BONDING_CURVE = 0
const MIGRATION_PROGRESS_CREATED_POOL = 3

/**
 * Coerce a decoded u8 flag to its integer value. Anchor decodes u8 fields
 * as plain numbers; tolerate bigint/boolean/BN-like shapes (mock and older
 * SDK surfaces) so a surprising shape degrades to "unknown" (null) rather
 * than throwing or silently reading as 0.
 */
function asMigrationByte(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint'
        ? Number(value)
        : typeof value === 'string' || typeof value === 'object'
          ? Number(String(value))
          : NaN
  return Number.isInteger(num) && num >= 0 && num <= 255 ? num : null
}

/**
 * Derive the pool's migration state from its on-chain flags and reserve.
 *
 *  - The `isMigrated` flag wins outright, even with drained reserves.
 *  - Terminal `migrationProgress` (CreatedPool) selects `migrated` even if
 *    the flag read missed — both are written by the same instruction.
 *  - Intermediate progress (PostBondingCurve / LockedVesting) is
 *    `migration_pending` regardless of the reserve reading: the curve is
 *    finished on-chain and no graduated pool exists yet.
 *  - A pool still on PreBondingCurve is `curve` until the reserve reaches
 *    the migration threshold, then `migration_pending` (the completion
 *    crank has not landed yet).
 *  - Missing/unparseable progress is `migration_pending` — fail closed.
 */
export function deriveDbcPoolMigrationState(input: {
  /** Pool `isMigrated` u8 (decoded shape varies — coerced, never trusted). */
  isMigrated: unknown
  /** Pool `migrationProgress` u8 (decoded shape varies — coerced). */
  migrationProgress: unknown
  quoteReserve: bigint
  migrationQuoteThreshold: bigint
}): DbcPoolMigrationState {
  if (asMigrationByte(input.isMigrated) === 1) return 'migrated'
  const progress = asMigrationByte(input.migrationProgress)
  if (progress === MIGRATION_PROGRESS_CREATED_POOL) return 'migrated'
  if (progress !== MIGRATION_PROGRESS_PRE_BONDING_CURVE) return 'migration_pending'
  return input.quoteReserve >= input.migrationQuoteThreshold ? 'migration_pending' : 'curve'
}
