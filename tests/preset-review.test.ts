import { describe, expect, it } from 'vitest'
import { reviewRows, sidesAgree, type ReviewInput } from '../src/shared/preset-review'
import type { ScrubReport } from '../src/shared/preset-manifest'

/**
 * ONE TRUTH, MADE CHECKABLE.
 *
 * The author's walk rules that the author's review and the buyer's show the
 * same list. That is a claim, and a claim nobody tests is exactly the kind of
 * guarantee this program keeps finding to be decorative — so the agreement is
 * asserted here rather than achieved by two surfaces being written carefully.
 */

const scrub = (over: Partial<ScrubReport> = {}): ScrubReport => ({
  sessions: true,
  paths: 'placeholders',
  commands: 2,
  notes: 3,
  urls: 1,
  secretScan: 'clean',
  findings: [],
  ...over
})

const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  scrub: scrub(),
  agents: 4,
  signed: true,
  ...over
})

describe('the list the author signs is the list the buyer reads', () => {
  it('both sides state the same facts', () => {
    expect(sidesAgree(input())).toBe(true)
  })

  it('agrees even when the package is unusual', () => {
    for (const variant of [
      input({ agents: 0 }),
      input({ scrub: scrub({ commands: 0, notes: 0, urls: 0 }) }),
      input({ signed: false }),
      input({ scrub: scrub({ secretScan: 'blocked', findings: [{ where: 'n1', kind: 'aws' }] }) })
    ]) {
      expect(sidesAgree(variant), JSON.stringify(variant.scrub)).toBe(true)
    }
  })

  it('carries every fact the walk names', () => {
    const rows = reviewRows(input(), 'author')
    expect(rows.map((r) => r.id)).toEqual([
      'team', 'paths', 'commands', 'notes', 'urls', 'scan', 'signature'
    ])
    expect(rows.find((r) => r.id === 'team')?.value).toBe(4)
    expect(rows.find((r) => r.id === 'commands')?.value).toBe(2)
    expect(rows.find((r) => r.id === 'notes')?.value).toBe(3)
  })

  it('paths states a KIND, not a count — a surface must not render 0', () => {
    // Paths are always rewritten to placeholders; there is no number that means
    // "none were", and a null rendered as "0 rewritten" would read as a scrub
    // that did nothing.
    expect(reviewRows(input(), 'author').find((r) => r.id === 'paths')?.value).toBeNull()
  })
})

describe('the refusal lands on the person who can fix it', () => {
  it('a dirty scan blocks the AUTHOR, before anything is signed', () => {
    const dirty = input({ scrub: scrub({ secretScan: 'blocked', findings: [{ where: 'n', kind: 'k' }] }) })
    const row = reviewRows(dirty, 'author').find((r) => r.id === 'scan')
    expect(row).toMatchObject({ value: 'blocked', blocking: true })
  })

  it('and does not block the BUYER, because a dirty package is unpublishable', () => {
    // By the time a buyer sees a package, a dirty one was never publishable —
    // so a buyer meeting this is meeting a package that disagrees with its own
    // report, which is report_mismatch and not this row's business.
    const dirty = input({ scrub: scrub({ secretScan: 'blocked' }) })
    expect(reviewRows(dirty, 'buyer').find((r) => r.id === 'scan')?.blocking).toBe(false)
  })

  it('a clean scan blocks nobody', () => {
    for (const side of ['author', 'buyer'] as const) {
      expect(reviewRows(input(), side).find((r) => r.id === 'scan')?.blocking).toBe(false)
    }
  })

  it('an unsigned package stops BOTH sides', () => {
    // Different reasons reaching the same place: the author has nothing to
    // publish, the buyer has nothing to verify.
    for (const side of ['author', 'buyer'] as const) {
      const row = reviewRows(input({ signed: false }), side).find((r) => r.id === 'signature')
      expect(row, side).toMatchObject({ value: 'unsigned', blocking: true })
    }
  })
})

describe('the file states facts and leaves the sentences to Velvet', () => {
  it('carries no prose to drift from her copy', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/shared/preset-review.ts', import.meta.url), 'utf8')
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Row values are counts and verdict words; anything sentence-shaped here
    // would be a second voice next to hers.
    expect(code).not.toMatch(/'[A-Z][a-z]+ [a-z]+ [a-z]+/)
  })
})
