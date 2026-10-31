import { describe, expect, it } from 'vitest'
import { inkStatusOfRow, inkStatusOfTurn, cornerOf } from '../src/renderer/src/zoom/ink-status'
import { brushPath, MARKS } from '../src/renderer/src/zoom/ink-marks'

describe('ink status — the five states the avatar draws', () => {
  it('reads a turn phase', () => {
    expect(inkStatusOfTurn('idle')).toBe('idle')
    expect(inkStatusOfTurn('thinking')).toBe('working')
    expect(inkStatusOfTurn('waiting')).toBe('waiting')
    expect(inkStatusOfTurn('replied')).toBe('done')
    expect(inkStatusOfTurn('off')).toBe('offline')
  })

  it('reads an agent row', () => {
    expect(inkStatusOfRow('working')).toBe('working')
    expect(inkStatusOfRow('waiting')).toBe('waiting')
    expect(inkStatusOfRow('offline')).toBe('offline')
    expect(inkStatusOfRow('quiet')).toBe('idle')
  })

  it('ticks a finished turn only while its reply is unread; once looked at it is idle', () => {
    expect(inkStatusOfRow('done', true)).toBe('done')
    expect(inkStatusOfRow('done', false)).toBe('idle')
    expect(inkStatusOfRow('done')).toBe('idle')
  })

  it('puts a corner mark on done (the tick) and offline (the z) and nowhere else', () => {
    expect(cornerOf('done')).toBe('tick')
    expect(cornerOf('offline')).toBe('zee')
    for (const s of ['idle', 'working', 'waiting'] as const) expect(cornerOf(s)).toBeNull()
  })
})

describe('ink marks — the status strokes', () => {
  it('draws every status stroke as a closed brush outline', () => {
    for (const name of ['ringWorking', 'ringWaiting', 'tick', 'zee'] as const) {
      expect(MARKS[name]).toBeTypeOf('function')
      const p = brushPath(name, { width: 6 })
      expect(p.body.startsWith('M')).toBe(true)
      expect(p.body.endsWith('Z')).toBe(true)
    }
  })

  it('closes the waiting ring past a full turn and keeps the working one to about a third', () => {
    const sweep = (name: 'ringWorking' | 'ringWaiting'): number => {
      const pts = MARKS[name]().pts
      let total = 0
      for (let i = 1; i < pts.length; i++) {
        const a0 = Math.atan2(pts[i - 1][1] - 50.5, pts[i - 1][0] - 50)
        const a1 = Math.atan2(pts[i][1] - 50.5, pts[i][0] - 50)
        let d = a1 - a0
        if (d > Math.PI) d -= 2 * Math.PI
        if (d < -Math.PI) d += 2 * Math.PI
        total += d
      }
      return Math.abs(total) / (2 * Math.PI)
    }
    expect(sweep('ringWaiting')).toBeGreaterThan(1)
    expect(sweep('ringWorking')).toBeGreaterThan(0.25)
    expect(sweep('ringWorking')).toBeLessThan(0.4)
  })
})
