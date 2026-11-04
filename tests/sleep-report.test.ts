// A SWEEP THAT SAYS NOTHING CAN BE DEAD FOR WEEKS.
//
// 2026-11-05: idle sleep ended about one agent a day while 37 sat idle, and
// nothing anywhere said so. The report is one line per running card with the
// reason it is still awake, so "why is this agent not asleep" is a read.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { reasonAwake, sleepReport, writeSleepReport } from '../src/main/sleep-report'

const facts = (over = {}) => ({ id: 'a', resumable: true, served: false, busy: false, ...over })

describe('reasonAwake', () => {
  it('names the gate that held the card, most specific first', () => {
    expect(reasonAwake(facts({ resumable: false }), null, null, false)).toBe('cannot be resumed exactly')
    expect(reasonAwake(facts({ served: true }), null, null, false)).toBe('served session')
    expect(reasonAwake(facts({ busy: true }), 'viewer', null, false)).toBe('busy: viewer')
  })

  it('what the evidence said outranks the clock', () => {
    expect(reasonAwake(facts(), null, 'claude says busy', true)).toBe('claude says busy')
  })

  it('a nominee with no verdict yet is waiting its turn at the evidence', () => {
    expect(reasonAwake(facts(), null, null, true)).toBe('nominated')
  })

  it('anything else is the clock', () => {
    expect(reasonAwake(facts(), null, null, false)).toBe('window not over')
  })
})

describe('sleepReport', () => {
  it('is one line per running card, with the window it was judged by', () => {
    const report = sleepReport({
      at: 5,
      pressure: 'high',
      windowMs: 1800000,
      cards: [{ id: 'a', name: 'Roaster', why: 'window not over' }]
    })
    expect(report).toEqual({
      at: 5,
      pressure: 'high',
      windowMin: 30,
      awake: 1,
      cards: [{ id: 'a', name: 'Roaster', why: 'window not over' }]
    })
  })
})

describe('writeSleepReport', () => {
  it('writes readable JSON', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'sleep-report-')), 'sleep-sweep.json')
    writeSleepReport(file, sleepReport({ at: 1, pressure: 'normal', windowMs: 60000, cards: [] }))
    expect(JSON.parse(readFileSync(file, 'utf8')).windowMin).toBe(1)
  })

  it('never throws: a report must not be what stops a sweep', () => {
    expect(() => writeSleepReport('/dev/null/nope/x.json', sleepReport({ at: 1, pressure: 'normal', windowMs: 0, cards: [] }))).not.toThrow()
  })
})
