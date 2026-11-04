// THE MACHINE IS A BUDGET, AND THE FLEET IS WHAT SPENDS IT.
//
// Measured 2026-11-05 on a 16 GB Mac: load 89, 54 % of CPU in the kernel, swap
// 13.6 of 14.3 GB, 36 GB of footprint. Nothing crashed; everything just paged.
// Free memory never shows this (macOS keeps it near zero by design), so
// pressure is read from swap against physical RAM.
import { describe, expect, it } from 'vitest'
import { parseSwapUsedMb, pressureOf, sleepColdLookups, sleepWindowMs } from '../src/main/machine-pressure'

const MIN = 60_000
const GB = 1024
const machine = (swapUsedMb: number, kernelLevel = 1) => ({ swapUsedMb, physicalMb: 16 * GB, kernelLevel })

describe('parseSwapUsedMb', () => {
  it('reads what sysctl vm.swapusage prints', () => {
    expect(parseSwapUsedMb('total = 14336.00M  used = 13641.12M  free = 694.88M  (encrypted)')).toBeCloseTo(13641.12)
    expect(parseSwapUsedMb('vm.swapusage: total = 1024.00M  used = 0.00M  free = 1024.00M')).toBe(0)
  })

  it('reads the gigabyte form too, and refuses what it cannot read', () => {
    expect(parseSwapUsedMb('total = 2.00G  used = 1.50G  free = 0.50G')).toBe(1536)
    expect(parseSwapUsedMb('nonsense')).toBeNull()
  })
})

describe('pressureOf', () => {
  it('a little swap is a normal Mac', () => {
    expect(pressureOf(machine(3 * GB))).toBe('normal')
  })

  it('a quarter of RAM in swap is high while the kernel agrees, half is critical regardless', () => {
    expect(pressureOf(machine(4 * GB, 2))).toBe('high')
    expect(pressureOf(machine(8 * GB))).toBe('critical')
    expect(pressureOf(machine(13.6 * GB))).toBe('critical')
  })

  it('swap the kernel has stopped worrying about is history: it drains for hours after a storm', () => {
    expect(pressureOf(machine(4 * GB, 1))).toBe('normal')
  })

  it('the kernel saying critical is critical, whatever swap says', () => {
    expect(pressureOf(machine(0, 4))).toBe('critical')
  })

  it('the kernel saying warn is not enough on its own: a busy Mac says it all day', () => {
    expect(pressureOf(machine(1 * GB, 2))).toBe('normal')
  })
})

describe('sleepWindowMs', () => {
  it('keeps the owner\'s hour while the machine is fine', () => {
    expect(sleepWindowMs('normal', 60 * MIN)).toBe(60 * MIN)
  })

  it('shrinks under pressure, and never below the fifteen minutes that stay above the 2026-11-01 ruling', () => {
    expect(sleepWindowMs('high', 60 * MIN)).toBe(30 * MIN)
    expect(sleepWindowMs('critical', 60 * MIN)).toBe(15 * MIN)
  })

  it('never lengthens a window set shorter by hand, and off stays off', () => {
    expect(sleepWindowMs('critical', 5 * MIN)).toBe(5 * MIN)
    expect(sleepWindowMs('critical', 0)).toBe(0)
  })
})

describe('sleepColdLookups', () => {
  it('stays gentle normally and clears a fleet in minutes when it has to', () => {
    expect(sleepColdLookups('normal')).toBe(2)
    expect(sleepColdLookups('critical')).toBeGreaterThanOrEqual(8)
  })
})
