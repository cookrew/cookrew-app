import { describe, expect, it } from 'vitest'
import { machineWhyShows, machineWhyWords } from '../src/renderer/src/zoom/machine-why'

/**
 * A MACHINE THE VIEW CANNOT GO INTO SAYS THE ONE THING TO DO (owner 2026-11-10,
 * on the Devices level: "Solis-Core is listed, not readable from here: open it
 * on that machine" is wrong once machines trust each other). Never "open it on
 * that machine".
 */

const solis = { name: 'Solis-Core', online: true }

describe('machineWhyWords', () => {
  it('an offline machine: when it is back', () => {
    expect(machineWhyWords({ name: 'Solis-Core', online: false }, { surface: 'desktop', trusted: true, block: null })).toBe('Solis-Core is offline. It opens here once it is back.')
  })

  it('a desktop that has not proved itself: the one button', () => {
    expect(machineWhyWords(solis, { surface: 'desktop', trusted: false, block: null, platform: 'darwin' })).toBe('Press “Sign this Mac in again to see your other machines” above, and Solis-Core opens here.')
    expect(machineWhyWords(solis, { surface: 'desktop', trusted: false, block: null, platform: 'linux' })).toBe('Press “Sign this machine in again to see your other machines” above, and Solis-Core opens here.')
  })

  it('a browser with no pass, or no account key: where to prove it once', () => {
    expect(machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'needs-proof' } })).toBe('Prove it’s you once at cookrew.dev/me (password or passkey), and Solis-Core opens here.')
    expect(machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'no-device' } })).toBe('Sign this browser in at cookrew.dev/me, and Solis-Core opens here.')
  })

  it('the machine’s own words when it turned this one away; a quiet one is asked again', () => {
    expect(machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'refused', message: 'This browser was forgotten there.' } })).toBe('Solis-Core: This browser was forgotten there.')
    expect(machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'offline' } })).toBe('Solis-Core isn’t answering right now. Try again in a moment.')
    expect(machineWhyWords(solis, { surface: 'desktop', trusted: true, block: null })).toBe('Solis-Core isn’t answering yet. It opens as soon as it does.')
  })

  it('a page with no way to other machines (a machine reached by its address): where it can be', () => {
    expect(machineWhyWords(solis, { surface: 'none', trusted: null, block: null })).toBe('Open cookrew.dev/me to go into Solis-Core from here.')
  })

  it('never sends anyone to the other machine', () => {
    const all = [
      machineWhyWords(solis, { surface: 'desktop', trusted: false, block: null }),
      machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'needs-proof' } }),
      machineWhyWords(solis, { surface: 'none', trusted: null, block: null })
    ]
    for (const words of all) expect(words).not.toMatch(/on that (machine|Mac|PC|computer)/)
  })
})

/**
 * THE SENTENCE BELONGS TO THE DEVICES STOP (owner screenshot 2026-11-10): it
 * points at a button "above" there, so it is said only while the view rests on
 * that stop, and gone once the view leaves it (it had followed into an agent's
 * full view, stretched over the chat).
 */
describe('machineWhyShows', () => {
  it('on the devices stop, and not in a full view', () => {
    expect(machineWhyShows(-2, false)).toBe(true)
    expect(machineWhyShows(-1.6, false)).toBe(true)
    expect(machineWhyShows(-2, true)).toBe(false)
  })

  it('on any other stop or passage: not said', () => {
    for (const v of [-1.5, -1, 0, 1, 2, 3]) expect(machineWhyShows(v, false)).toBe(false)
  })
})
