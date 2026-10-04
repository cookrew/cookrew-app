import { describe, expect, it } from 'vitest'
import { landWords } from '../src/renderer/src/LanePane'

/** Every landing answer has words a card can show, and none of them is "error". */
describe('what a landing says', () => {
  it('counts what landed and where', () => {
    expect(landWords({ ok: true, landed: 'abc1234', commits: 1, closed: false })).toBe('Landed 1 commit → abc1234')
    expect(landWords({ ok: true, landed: 'abc1234', commits: 3, closed: true })).toBe('Landed 3 commits → abc1234, lane closed')
  })
  it('names the files a refusal is about, and whose part the fix is', () => {
    expect(landWords({ ok: false, reason: 'dirty', files: ['a.ts'] })).toContain('a.ts')
    expect(landWords({ ok: false, reason: 'conflict', files: ['x.ts', 'y.ts'] })).toContain('x.ts, y.ts')
    expect(landWords({ ok: false, reason: 'main-dirty', files: ['index.ts'] })).toContain('nobody should edit there')
    expect(landWords({ ok: false, reason: 'gate', detail: 'tsc: 3 errors' })).toContain('tsc: 3 errors')
    // The gate that ran is named, so a refusal says WHAT failed, not just that something did.
    expect(landWords({ ok: false, reason: 'gate', gate: 'npm run typecheck', detail: 'tsc: 3 errors' })).toBe(
      'The gate failed in the lane (npm run typecheck):\ntsc: 3 errors'
    )
    expect(landWords({ ok: true, landed: 'abc1234', commits: 1, closed: false, gate: 'npm run typecheck' })).toBe(
      'Landed 1 commit → abc1234 · gate: npm run typecheck'
    )
    expect(landWords({ ok: true, landed: 'abc1234', commits: 1, closed: false, gate: null })).toBe(
      'Landed 1 commit → abc1234 · no gate'
    )
    expect(landWords({ ok: false, reason: 'nothing' })).toContain('Nothing to land')
    expect(landWords({ ok: false, reason: 'main-branch', detail: 'the shared tree is on HEAD' })).toContain('HEAD')
  })
})
