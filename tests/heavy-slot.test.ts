// A WHOLE-SUITE RUN IS THE HEAVIEST THING AN AGENT DOES, AND THEY ALL DO IT.
//
// Measured 2026-11-05: four whole-suite vitest runs at once, nine workers each,
// on ten cores: load 135 with memory already recovered. A slot is a file named
// for its holder, so a run that dies frees its slot just by being dead.
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWholeSuiteRun, liveSlots, slotCount, takeHeavySlot } from '../scripts/heavy-slot.mjs'

const fresh = () => mkdtempSync(path.join(tmpdir(), 'heavy-slot-'))
const NOW = 1_800_000_000_000

describe('isWholeSuiteRun', () => {
  it('a plain run queues, whatever flags it carries', () => {
    expect(isWholeSuiteRun(['run'])).toBe(true)
    expect(isWholeSuiteRun(['run', '--config', 'vitest.all.tmp.config.ts', '--reporter=dot'])).toBe(true)
    expect(isWholeSuiteRun(['run', '--reporter', 'dot'])).toBe(true)
  })

  it('naming the tests directory is still the whole suite', () => {
    expect(isWholeSuiteRun(['run', 'tests/'])).toBe(true)
    expect(isWholeSuiteRun(['run', 'tests'])).toBe(true)
  })

  it('a flag value is not a filter, so an --exclude cannot skip the queue', () => {
    expect(isWholeSuiteRun(['run', '--exclude', 'tests/x.test.ts'])).toBe(true)
  })

  it('any filter or name pattern is small enough to skip the queue', () => {
    expect(isWholeSuiteRun(['run', 'tests/agent-sleep.test.ts'])).toBe(false)
    expect(isWholeSuiteRun(['run', 'agent-sleep'])).toBe(false)
    expect(isWholeSuiteRun(['run', '-t', 'wakes'])).toBe(false)
    expect(isWholeSuiteRun(['run', '--testNamePattern=wakes'])).toBe(false)
  })

  it('a watch or ui session never holds a slot: it stays open for hours', () => {
    expect(isWholeSuiteRun(['watch'])).toBe(false)
    expect(isWholeSuiteRun(['dev'])).toBe(false)
    expect(isWholeSuiteRun(['run', '--ui'])).toBe(false)
    expect(isWholeSuiteRun(['--watch'])).toBe(false)
    expect(isWholeSuiteRun([], true)).toBe(false)
  })

  it('a bare vitest with no terminal is a run: that is an agent\'s Bash tool', () => {
    expect(isWholeSuiteRun([], false)).toBe(true)
  })
})

describe('slotCount', () => {
  it('defaults to two, takes a number, and 0 turns the gate off', () => {
    expect(slotCount(undefined)).toBe(2)
    expect(slotCount('3')).toBe(3)
    expect(slotCount('0')).toBe(0)
    expect(slotCount('garbage')).toBe(2)
  })
})

describe('liveSlots', () => {
  it('a slot whose holder is dead is free, and its file is swept', () => {
    const dir = fresh()
    writeFileSync(path.join(dir, `${NOW}-111`), '')
    writeFileSync(path.join(dir, `${NOW}-222`), '')
    expect(liveSlots(dir, { isAlive: (pid) => pid === 222, now: NOW })).toEqual([`${NOW}-222`])
    expect(readdirSync(dir)).toEqual([`${NOW}-222`])
  })

  it('a slot older than any real run is free: a recycled pid must not hold it forever', () => {
    const dir = fresh()
    writeFileSync(path.join(dir, `${NOW - 3 * 3_600_000}-111`), '')
    expect(liveSlots(dir, { isAlive: () => true, now: NOW })).toEqual([])
  })

  it('oldest first, so two racers agree who is in', () => {
    const dir = fresh()
    writeFileSync(path.join(dir, `${NOW + 5}-111`), '')
    writeFileSync(path.join(dir, `${NOW}-222`), '')
    expect(liveSlots(dir, { isAlive: () => true, now: NOW })).toEqual([`${NOW}-222`, `${NOW + 5}-111`])
  })
})

describe('takeHeavySlot', () => {
  const opts = (dir: string, over = {}) => ({
    dir, slots: 2, pid: 333, isAlive: () => true, maxWaitMs: 1000, pollMs: 10, now: () => NOW, sleep: async () => {}, ...over
  })

  it('takes a free slot at once', async () => {
    const dir = fresh()
    expect(await takeHeavySlot(opts(dir))).toEqual({ taken: true, waitedMs: 0 })
    expect(readdirSync(dir)).toEqual([`${NOW}-333`])
  })

  it('waits while the slots are full, and goes in when one frees', async () => {
    const dir = fresh()
    writeFileSync(path.join(dir, `${NOW - 2}-111`), '')
    writeFileSync(path.join(dir, `${NOW - 1}-222`), '')
    const alive = new Set([111, 222, 333])
    let waits = 0
    const out = await takeHeavySlot(opts(dir, {
      isAlive: (pid: number) => alive.has(pid),
      sleep: async () => { waits += 1; if (waits === 3) alive.delete(111) }
    }))
    expect(out.taken).toBe(true)
    expect(waits).toBe(3)
  })

  it('gives up waiting rather than failing the run: a slow suite beats no suite', async () => {
    const dir = fresh()
    writeFileSync(path.join(dir, `${NOW - 2}-111`), '')
    writeFileSync(path.join(dir, `${NOW - 1}-222`), '')
    let t = NOW
    const out = await takeHeavySlot(opts(dir, { now: () => t, sleep: async () => { t += 400 } }))
    expect(out.taken).toBe(false)
    // It runs anyway, so it stays counted: later arrivals must queue behind it.
    expect(readdirSync(dir).filter((f) => f.endsWith('-333'))).toHaveLength(1)
  })

  it('zero slots is the gate switched off', async () => {
    const dir = fresh()
    expect(await takeHeavySlot(opts(dir, { slots: 0 }))).toEqual({ taken: false, waitedMs: 0 })
    expect(readdirSync(dir)).toEqual([])
  })

  it('an unwritable directory never stops a test run', async () => {
    const out = await takeHeavySlot(opts('/dev/null/nope'))
    expect(out.taken).toBe(false)
  })
})
