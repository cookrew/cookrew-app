import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StrataMachine } from '../src/shared/strata'
import {
  createHoverIntent,
  EMBED_EXCHANGES,
  HOVER_INTENT_MS,
  machineExchanges,
  maxWarmEmbeds,
  obviousTarget,
  RELAY_EXCHANGES_PER_DESKTOP,
  SHELL_EXCHANGES_PER_MACHINE
} from '../src/strata/embed/budget'

const m = (id: string, link: StrataMachine['link']): StrataMachine => ({
  id,
  name: id,
  online: true,
  lastSeenAt: null,
  appVersion: null,
  profile: null,
  base: `/m/${id}/`,
  link,
  levels: null,
  stale: false
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the relay budget', () => {
  it('fits a machine’s share inside the relay’s per-desktop cap', () => {
    expect(SHELL_EXCHANGES_PER_MACHINE).toBeLessThanOrEqual(RELAY_EXCHANGES_PER_DESKTOP / 2)
    expect(machineExchanges(EMBED_EXCHANGES, true)).toBe(SHELL_EXCHANGES_PER_MACHINE)
    expect(machineExchanges(EMBED_EXCHANGES, false)).toBe(1)
  })

  it('keeps two warm documents on a phone and three on a desktop', () => {
    expect(maxWarmEmbeds(true)).toBe(2)
    expect(maxWarmEmbeds(false)).toBe(3)
  })
})

describe('what to prewarm', () => {
  const fleet = [m('a', 'live'), m('b', 'offline'), m('c', 'unpaired')]

  it('inside a machine, that machine', () => {
    expect(obviousTarget({ machine: 'b' }, fleet)).toBe('b')
    expect(obviousTarget({ machine: 'a', workspace: 'w' }, fleet)).toBe('a')
  })

  it('on level 0, only the one machine online, once it is live', () => {
    const solo = [m('a', 'live'), { ...m('b', 'offline'), online: false }]
    expect(obviousTarget({}, solo)).toBe('a')
    expect(obviousTarget({}, [...solo, m('d', 'live')])).toBeNull()
    expect(obviousTarget({}, [m('a', 'live'), m('e', 'connecting')])).toBeNull()
  })

  it('prewarms on a lingering hover, not a passing one', () => {
    const prewarm = vi.fn()
    const intent = createHoverIntent(prewarm, { setTimer: setTimeout, clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) })
    intent.enter('a')
    vi.advanceTimersByTime(HOVER_INTENT_MS - 1)
    intent.enter('b')
    vi.advanceTimersByTime(HOVER_INTENT_MS - 1)
    intent.leave()
    vi.advanceTimersByTime(HOVER_INTENT_MS * 2)
    expect(prewarm).not.toHaveBeenCalled()
    intent.enter('c')
    vi.advanceTimersByTime(HOVER_INTENT_MS)
    expect(prewarm).toHaveBeenCalledWith('c')
  })
})
