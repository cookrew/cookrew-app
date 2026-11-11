import { describe, expect, it } from 'vitest'
import { MIN_MACHINE_VERSION, machineOutdated } from '../src/shared/machine-version'
import { MIN_MACHINE_VERSION as CONSOLE_FLOOR } from '../src/renderer/src/console/console-devices'
import { gaugedMachines } from '../src/renderer/src/zoom/gauged-machines'

/**
 * THE OLDEST MACHINE THIS BUILD READS (shared/machine-version.ts). 0.6.0 is the
 * first build that speaks the account's pass at a machine's door, so an older
 * one is told to update and is ASKED NOTHING: not on the console's Devices
 * level, and not from inside another machine, where the same list is drawn
 * again (found in the real-browser acceptance: the old machine was being asked
 * to pair and to send its fleet from there).
 */
describe('which machines are too old to read', () => {
  it('anything below the floor is, at any of the three places', () => {
    for (const old of ['0.5.8', '0.5.10', '0.5.99', '0.0.1']) expect(machineOutdated(old), old).toBe(true)
    for (const fine of ['0.6.0', '0.6.1', '0.10.0', '1.0.0']) expect(machineOutdated(fine), fine).toBe(false)
  })

  it('a suffix does not change which protocol a build speaks', () => {
    expect(machineOutdated('0.6.0-beta.1')).toBe(false)
    expect(machineOutdated('0.5.10+build.7')).toBe(true)
  })

  it('a version that cannot be read is not taken for a new one', () => {
    for (const unread of [null, '', 'latest', '0.6', 'v0.6.0', '0.6.0.1']) expect(machineOutdated(unread), String(unread)).toBe(true)
  })

  it('is one floor: the console’s Devices level names the same one', () => {
    expect(CONSOLE_FLOOR).toBe(MIN_MACHINE_VERSION)
    expect(MIN_MACHINE_VERSION).toBe('0.6.0')
  })
})

describe('whose gauges are read on the devices stop', () => {
  const machines = [
    { id: 'me', name: 'Studio', local: true, online: true, appVersion: '0.6.0' },
    { id: 'a', name: 'Laptop', local: false, online: true, appVersion: '0.6.0' },
    { id: 'old', name: 'Attic', local: false, online: true, appVersion: '0.5.8' },
    { id: 'unknown', name: 'Shed', local: false, online: true, appVersion: null }
  ]

  it('on the console, a machine below the floor gets no line: reading its gauges would be asking it', () => {
    expect(gaugedMachines(machines, true).map((m) => m.id)).toEqual(['a'])
  })

  it('in the app, every other machine has its line, as before', () => {
    expect(gaugedMachines(machines, false).map((m) => m.id)).toEqual(['a', 'old', 'unknown'])
  })
})
