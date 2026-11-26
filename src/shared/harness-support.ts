import { HARNESS_IDS, type HarnessId } from './harness-catalog'

// PER-HARNESS FEATURE TABLES (harness-integration-contract rule 9).
//
// Every feature that behaves differently per harness is ONE table,
// `PerHarness<T>`, keyed by every HarnessId: the value is the feature's
// implementation for that harness, or `unsupported('why')`. There is no
// default and no optional key, so a new harness id fails to compile at every
// feature until each one is declared — the silent fall-through that made a
// bare registry entry lose recover, resume and the trace drawer (found
// 2026-11-25) cannot be written. An unsupported feature says why, and the
// caller refuses honestly with that reason instead of guessing.
// tests/harness-matrix.test.ts collects every table into one matrix.

export interface Unsupported {
  readonly unsupported: string
}

export type Support<T> = T | Unsupported

export type PerHarness<T> = Readonly<Record<HarnessId, Support<T>>>

/** A declared absence, with the reason a card or a log can show. */
export function unsupported(reason: string): Unsupported {
  if (reason.trim().length === 0) throw new Error('unsupported() needs a reason')
  return Object.freeze({ unsupported: reason })
}

export function isUnsupported(value: unknown): value is Unsupported {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { unsupported?: unknown }).unsupported === 'string'
  )
}

/** The implementation for a harness, or null when it is unsupported or there is no harness. */
export function supportFor<T>(table: PerHarness<T>, id: HarnessId | null | undefined): T | null {
  if (id === null || id === undefined) return null
  const entry = table[id]
  return isUnsupported(entry) ? null : (entry as T)
}

/** Why a harness lacks a feature, or null when it has it. */
export function unsupportedReason<T>(table: PerHarness<T>, id: HarnessId): string | null {
  const entry = table[id]
  return isUnsupported(entry) ? entry.unsupported : null
}

/** Which harnesses a table supports, in catalog order (matrix test, docs). */
export function supportedIds<T>(table: PerHarness<T>): HarnessId[] {
  return HARNESS_IDS.filter((id) => !isUnsupported(table[id]))
}
