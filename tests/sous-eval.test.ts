import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — the eval is a plain .mjs script, imported here for its own arithmetic
import { readDecisions, summarise, reDecided, substituted, heldMs, THEATRE_MS } from '../scripts/sous-eval.mjs'

/**
 * THE EVAL'S ARITHMETIC, AGAINST HAND-COMPUTED NUMBERS.
 *
 * tests/fixtures/sous-ledger/sample.jsonl is 40 synthetic lines folding to 30 decisions, built so
 * every band, outcome and owner response appears and so the medians fall on values a person can
 * check: ticking holds are 120…360 ms in steps of 20 with one decision never answered, paused are
 * 400…1800 in steps of 200 with one expiry, question 500/700/900/1100, answer 100/150/200.
 *
 * Every expected number below was derived from that layout by hand and then checked against a
 * second, independent implementation (a short Python pass over the same file) before being written
 * here — so a passing test means two different programs agree, not that the script agrees with
 * itself.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'sous-ledger', 'sample.jsonl')
const text = readFileSync(FIXTURE, 'utf8')
const read = readDecisions(text) as { decisions: unknown[]; lines: number; skipped: number }
const summary = summarise(read.decisions) as {
  decisions: number
  bands: { band: string; count: number; reDecideRate: number | null; substitutionRate: number | null; medianHoldMs: number | null; answered: number; rejects: number; theatre: boolean }[]
  askVsRecruit: { ask: number; recruit: number; neither: number }
  domains: [string, number][]
  exposure: [string | number, number][]
  ownerResponse: [string, number][]
  outcomes: [string, number][]
  dismissed: number
  notMeasured: Record<string, string>
}
const band = (name: string): (typeof summary.bands)[number] => {
  const hit = summary.bands.find((b) => b.band === name)
  if (!hit) throw new Error(`no ${name} band in the summary`)
  return hit
}

describe('the fixture itself covers every outcome the schema allows', () => {
  it('is 40 lines folding to 30 decisions', () => {
    expect(read.lines).toBe(40)
    expect(read.skipped).toBe(0)
    expect(summary.decisions).toBe(30)
  })

  it('carries every SousOutcome and every ownerResponse, including null', () => {
    const outcomes = new Set(summary.outcomes.map(([k]) => k))
    for (const o of ['pending', 'delivered', 'failed', 'interrupted', 'cancelled', 'expired']) expect(outcomes).toContain(o)
    const responses = new Set(summary.ownerResponse.map(([k]) => k))
    for (const r of ['commit', 'send-anyway', 'cancel', 'expired', '(none)']) expect(responses).toContain(r)
  })

  it('carries all four modes and all four exposure levels', () => {
    expect(summary.bands.map((b) => b.band).sort()).toEqual(['answer', 'paused', 'question', 'ticking'])
    expect(summary.exposure.map(([k]) => Number(k)).sort()).toEqual([0, 1, 2, 3])
  })
})

describe('per band: count, re-decide, substitution, median hold, theatre', () => {
  /** 14 decisions; 2 briefs edited (t03, t09) → 2/14; one target moved (t06) → 1/14; holds 120…360 with t14 unanswered → median of 13 = 240. */
  it('ticking', () => {
    const b = band('ticking')
    expect(b.count).toBe(14)
    expect(b.reDecideRate).toBe(14.3)
    expect(b.substitutionRate).toBe(7.1)
    expect(b.medianHoldMs).toBe(240)
    expect(b.answered).toBe(13)
    expect(b.rejects).toBe(0)
  })

  /** 9 decisions; 3 cancels + 1 Boundaries rewrite → 4/9; two targets moved (t17, t20) → 2/9; 8 answered (t23 expired), holds 400…1800 → median (1000+1200)/2 = 1100. */
  it('paused', () => {
    const b = band('paused')
    expect(b.count).toBe(9)
    expect(b.reDecideRate).toBe(44.4)
    expect(b.substitutionRate).toBe(22.2)
    expect(b.medianHoldMs).toBe(1100)
    expect(b.answered).toBe(8)
    expect(b.rejects).toBe(3)
  })

  /** 4 decisions, one cancel → 25%; no substitutions; holds 500/700/900/1100 → median (700+900)/2 = 800. */
  it('question', () => {
    const b = band('question')
    expect(b.count).toBe(4)
    expect(b.reDecideRate).toBe(25)
    expect(b.substitutionRate).toBe(0)
    expect(b.medianHoldMs).toBe(800)
    expect(b.answered).toBe(4)
    expect(b.rejects).toBe(1)
  })

  /** 3 decisions, holds 100/150/200 → median 150, nobody ever said no. */
  it('answer', () => {
    const b = band('answer')
    expect(b.count).toBe(3)
    expect(b.reDecideRate).toBe(0)
    expect(b.substitutionRate).toBe(0)
    expect(b.medianHoldMs).toBe(150)
    expect(b.rejects).toBe(0)
  })

  /**
   * THE THEATRE SIGNAL is the point of the whole report: a band whose median hold is under 300 ms
   * and whose rejects are zero is a pause nobody has ever used — it looks like a decision point
   * and is decoration. `ticking` (240 ms, 0 rejects) and `answer` (150 ms, 0) are theatre here;
   * `paused` is not, at 1,100 ms with three rejects, which is a gate doing its job.
   */
  it('flags only the bands that are short AND never refused', () => {
    expect(THEATRE_MS).toBe(300)
    expect(band('ticking').theatre).toBe(true)
    expect(band('answer').theatre).toBe(true)
    expect(band('paused').theatre).toBe(false)
    expect(band('question').theatre).toBe(false)
  })
})

describe('the splits', () => {
  it('counts ask against recruit by the harness: prefix on the folded target', () => {
    // 30 decisions: one has no target at all (the question Sous asked back), four went to a harness.
    expect(summary.askVsRecruit).toEqual({ ask: 25, recruit: 4, neither: 1 })
  })

  it('counts the domains and the exposure distribution', () => {
    expect(Object.fromEntries(summary.domains)).toEqual({ repo: 14, chore: 12, question: 4 })
    expect(Object.fromEntries(summary.exposure.map(([k, v]) => [String(k), v]))).toEqual({ '0': 14, '1': 7, '2': 4, '3': 5 })
  })

  it('counts dismissals off the folded row', () => {
    expect(summary.dismissed).toBe(2)
  })
})

describe('what the schema cannot answer is said, not zeroed', () => {
  /**
   * Design §6 wants four numbers; the shipped ledger supports two. A zero for completion would
   * read as "nothing ever completes" and a zero for agreement as "Jev and the rules never agree" —
   * both lies about a column that does not exist, so the script reports absence instead.
   */
  it('reports completion as not measured, with the reason', () => {
    expect(summary.notMeasured.completion).toMatch(/needs the completion Noul/)
    expect(summary.notMeasured.completion).toMatch(/no completion column/)
    expect(JSON.stringify(summary)).not.toMatch(/"completion":\s*0/)
  })

  it('reports Jev-against-draft0 as not measured too', () => {
    expect(summary.notMeasured.jevVsDraft0).toMatch(/neither the Jev answers nor the rule draft/)
  })
})

describe('the per-decision predicates', () => {
  const byToken = (token: string): { first: { token: string } } =>
    (read.decisions as { first: { token: string } }[]).find((d) => d.first.token === token)!

  it('calls an edited brief and a cancel both re-decided, and a clean commit neither', () => {
    expect(reDecided(byToken('t03'))).toBe(true) // the sentence changed before the owner answered
    expect(reDecided(byToken('t16'))).toBe(true) // cancel
    expect(reDecided(byToken('t22'))).toBe(true) // the Boundaries line was appended to the proposal
    expect(reDecided(byToken('t01'))).toBe(false)
  })

  it('calls a moved target a substitution, including one that became a recruit', () => {
    expect(substituted(byToken('t06'))).toBe(true)
    expect(substituted(byToken('t20'))).toBe(true) // card → harness:Claude Code
    expect(substituted(byToken('t01'))).toBe(false)
  })

  it('gives no hold for a decision nobody answered, and none for an expiry', () => {
    expect(heldMs(byToken('t14'))).toBeNull() // never answered
    expect(heldMs(byToken('t23'))).toBeNull() // expired: the clock, not the owner
    expect(heldMs(byToken('t01'))).toBe(120)
  })
})
