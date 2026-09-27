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
    expect(landWords({ ok: false, reason: 'nothing' })).toContain('Nothing to land')
    expect(landWords({ ok: false, reason: 'main-branch', detail: 'the shared tree is on HEAD' })).toContain('HEAD')
  })
})
