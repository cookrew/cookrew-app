// THE CREW'S ACTIVITY, AT MOST ONCE PER WINDOW (perf, 2026-11-01): App re-rendered
// the whole tree on every activity event, 10-20 a second while agents worked.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coalesceEvery } from '../src/renderer/src/activity-thumb-store'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function source() {
  let listener: (() => void) | null = null
  return { subscribe: (cb: () => void) => ((listener = cb), () => (listener = null)), emit: () => listener?.(), listening: () => listener !== null }
}

describe('coalesceEvery', () => {
  it('passes the first change at once and folds the rest of the window into one, which always lands', () => {
    const s = source()
    const flush = vi.fn()
    coalesceEvery(300, s.subscribe, flush, () => Date.now())
    s.emit()
    vi.advanceTimersByTime(0)
    expect(flush).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) {
      s.emit()
      vi.advanceTimersByTime(10)
    }
    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    expect(flush).toHaveBeenCalledTimes(2) // the last change landed
    vi.advanceTimersByTime(5000)
    expect(flush).toHaveBeenCalledTimes(2) // nothing changed since
  })

  it('stops, and drops a pending flush, when unsubscribed', () => {
    const s = source()
    const flush = vi.fn()
    const off = coalesceEvery(300, s.subscribe, flush, () => Date.now())
    s.emit()
    vi.advanceTimersByTime(0)
    s.emit()
    off()
    vi.advanceTimersByTime(1000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(s.listening()).toBe(false)
  })
})

describe('the crew', () => {
  it('reads its activity coalesced, not every event', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src/renderer/src/stage/crew-rows.ts'), 'utf8')
    expect(src).toContain('const activities = useActivitiesEvery(CREW_ACTIVITY_MS)')
    expect(src).not.toContain('useActivitiesSnapshot()')
  })
})

describe('the crew lives in context, not in App', () => {
  it('App provides it and its three readers take it from context, so a crew change does not re-render the app', () => {
    const app = readFileSync(path.join(__dirname, '..', 'src/renderer/src/App.tsx'), 'utf8')
    expect(app).not.toMatch(/useCrew\(/)
    expect(app).toContain('<CrewProvider workspace={workspace} workspaceId={activeWsId}>')
    expect(app.match(/<WithCrew>/g)?.length).toBe(2)
  })
})
