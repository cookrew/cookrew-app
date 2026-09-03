import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pulse } from '../registry/src/pulse'

/**
 * THE PULSE counts what happened today — lines opened per door, pages viewed —
 * and never who. It is what makes "serving right now" a number that moves.
 */

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pulse-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('counting a door', () => {
  it('a line is a line and a call; a call is only a call', () => {
    const pulse = new Pulse(dir)
    pulse.door('@drej/cookrew-alpha', 'line')
    pulse.door('@drej/cookrew-alpha', 'call')
    pulse.door('@drej/cookrew-alpha', 'call')
    expect(pulse.doorToday('@drej/cookrew-alpha')).toEqual({ lines: 1, calls: 3 })
    expect(pulse.doorToday('@nobody/nothing')).toEqual({ lines: 0, calls: 0 })
    expect(pulse.linesToday()).toBe(1)
  })

  it('today is a UTC day; yesterday does not count', () => {
    let now = Date.UTC(2026, 8, 3, 23, 59, 0)
    const pulse = new Pulse(dir, () => now)
    pulse.door('@drej/cookrew-alpha', 'line')
    now = Date.UTC(2026, 8, 4, 0, 1, 0)
    expect(pulse.doorToday('@drej/cookrew-alpha')).toEqual({ lines: 0, calls: 0 })
    expect(pulse.linesToday()).toBe(0)
  })
})

describe('counting pages', () => {
  it('per path, per day, and it survives a restart', () => {
    const pulse = new Pulse(dir)
    pulse.page('/')
    pulse.page('/')
    pulse.page('/market')
    pulse.flush()
    expect(new Pulse(dir).pagesToday()).toEqual({ '/': 2, '/market': 1 })
    const raw = JSON.parse(readFileSync(path.join(dir, 'pulse.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw)).toHaveLength(1)
    expect(JSON.stringify(raw)).not.toMatch(/cookie|token|sub/)
  })

  it('drops days older than thirty on write', () => {
    let now = Date.UTC(2026, 6, 1)
    const pulse = new Pulse(dir, () => now)
    pulse.page('/old')
    pulse.flush()
    now = Date.UTC(2026, 8, 3)
    pulse.page('/new')
    pulse.flush()
    const raw = JSON.parse(readFileSync(path.join(dir, 'pulse.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw)).toEqual(['2026-09-03'])
  })
})
