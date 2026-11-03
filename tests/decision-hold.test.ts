import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHold, enterSubmits } from '../src/renderer/src/decision-hold'
import type { Decision } from '../src/main/sous-control'

// THE HOLD/COMMIT PATH (fix round 1, CRITICAL 1 and 2). The review found the
// box returning null while its hold kept ticking — a decision committed
// unseen — and "change" leaving the hold running while the owner chose. The
// machine under the box is tested here with fake timers; the box only draws it.

const decision: Decision = {
  kind: 'ask',
  target: { id: 'forge', name: 'Forge' },
  alternates: [{ kind: 'ask' as const, id: 'tinker', name: 'Tinker', reasons: ['idle', 'same repo', 'role: Bugfix'] }],
  reasons: ['idle', 'same repo', 'last touched README · 2h'],
  recruit: { harness: 'Claude Code' as const, name: 'Install Section', beside: null, direct: true },
  domain: 'repo' as const,
  exposure: 1 as const,
  exposureWhy: 'make',
  boundaries: null,
  mode: 'ticking' as const,
  route: null,
  token: 't1',
  holdMs: 1500,
  sentence: 'Make the install section of README English'
}

function harness(d: Decision = decision) {
  const commits: (string | undefined)[] = []
  const cancels: string[] = []
  const ticks: number[] = []
  const hold = createHold(d, {
    holdMs: d.holdMs,
    onTick: (left) => ticks.push(left),
    onCommit: (target) => commits.push(target),
    onCancel: (token) => cancels.push(token)
  })
  return { hold, commits, cancels, ticks }
}

describe('the hold', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('commits by itself at the end of the hold, once', () => {
    const h = harness()
    vi.advanceTimersByTime(1400)
    expect(h.commits).toEqual([])
    vi.advanceTimersByTime(200)
    expect(h.commits).toEqual([undefined])
    expect(h.hold.state).toBe('committed')
    vi.advanceTimersByTime(5000)
    expect(h.commits).toHaveLength(1)
    expect(h.ticks[0]).toBe(1400)
  })

  it('CRITICAL 1 · closing at 1.0 s cancels: no commit ever, and main is told to drop the token', () => {
    const h = harness()
    vi.advanceTimersByTime(1000)
    h.hold.close()
    vi.advanceTimersByTime(10_000)
    expect(h.commits).toEqual([])
    expect(h.cancels).toEqual(['t1'])
    expect(h.hold.state).toBe('closed')
    // a commit after close is refused by the machine too
    h.hold.commit('tinker')
    expect(h.commits).toEqual([])
  })

  it('CRITICAL 2 · opening change at 1.0 s pauses; 3 s later nothing has committed; the alternate commits once with its target', () => {
    const h = harness()
    vi.advanceTimersByTime(1000)
    h.hold.pause()
    vi.advanceTimersByTime(3000)
    expect(h.commits).toEqual([])
    expect(h.hold.state).toBe('paused')
    h.hold.commit('tinker')
    expect(h.commits).toEqual(['tinker'])
    h.hold.commit('tinker')
    expect(h.commits).toHaveLength(1)
  })

  it('a keystroke pauses and the hold can resume where it left off', () => {
    const h = harness()
    vi.advanceTimersByTime(500)
    h.hold.pause()
    expect(h.hold.left).toBe(1000)
    vi.advanceTimersByTime(2000)
    h.hold.resume()
    vi.advanceTimersByTime(900)
    expect(h.commits).toEqual([])
    vi.advanceTimersByTime(200)
    expect(h.commits).toEqual([undefined])
  })

  it('Enter commits at once', () => {
    const h = harness()
    vi.advanceTimersByTime(100)
    h.hold.commit()
    expect(h.commits).toEqual([undefined])
    vi.advanceTimersByTime(5000)
    expect(h.commits).toHaveLength(1)
  })

  it('a question never ticks and never commits', () => {
    const h = harness({ ...decision, kind: 'question', question: 'Is that a task?', mode: 'question', answer: null } as Decision)
    vi.advanceTimersByTime(10_000)
    expect(h.commits).toEqual([])
    expect(h.hold.state).toBe('paused')
    h.hold.resume()
    expect(h.hold.state).toBe('paused')
  })
})

describe('Enter and the IME', () => {
  it('submits on a plain Enter, never while composing', () => {
    expect(enterSubmits({ key: 'Enter' })).toBe(true)
    expect(enterSubmits({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false)
    expect(enterSubmits({ key: 'Enter', isComposing: true })).toBe(false)
    expect(enterSubmits({ key: 'a' })).toBe(false)
  })
})
