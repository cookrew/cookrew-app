import { describe, expect, it } from 'vitest'
import { createMachinePaths, pathWordOf } from '../src/renderer/src/console/machine-paths'

/**
 * THE PATH EACH MACHINE IS REACHED OVER, as the Devices level says it on each
 * tile. A machine that was entered is on the path its session last settled on;
 * one that never was is read through the relay, and says so. A path is a fact
 * about now: nothing of it is kept past the page.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('the path a machine is reached over', () => {
  it('is the relay until something nearer was proved', () => {
    const paths = createMachinePaths()
    expect(paths.of(A)).toBe('RELAY')
  })

  it('is what its own session settled on, told to whoever draws it, per machine', () => {
    const paths = createMachinePaths()
    let told = 0
    paths.subscribe(() => (told += 1))
    paths.note(A, { origin: `https://192-168-1-24.${A}.d.cookrew.dev:8643`, kind: 'lan' })
    expect(paths.of(A)).toBe('LAN')
    expect(paths.of(B)).toBe('RELAY')
    expect(told).toBe(1)
    paths.note(A, { origin: `https://192-168-1-24.${A}.d.cookrew.dev:8643`, kind: 'lan' })
    expect(told).toBe(1)
    paths.note(B, { origin: '', kind: 'tailnet', transport: 'rtc' })
    expect(paths.of(B)).toBe('TAILNET')
    // Fallen back: said.
    paths.note(A, { origin: '', kind: 'relay' })
    expect(paths.of(A)).toBe('RELAY')
    expect(told).toBe(3)
  })

  it('is forgotten on sign-out', () => {
    const paths = createMachinePaths()
    paths.note(A, { origin: '', kind: 'lan', transport: 'rtc' })
    paths.forget()
    expect(paths.of(A)).toBe('RELAY')
  })

  it('has one word per path', () => {
    expect(pathWordOf({ origin: '', kind: 'relay' })).toBe('RELAY')
    expect(pathWordOf({ origin: 'https://x', kind: 'lan' })).toBe('LAN')
    expect(pathWordOf({ origin: '', kind: 'tailnet', transport: 'rtc' })).toBe('TAILNET')
  })
})
