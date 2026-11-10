import { describe, expect, it } from 'vitest'
import { machineSays } from '../src/renderer/src/zoom/machine-why'
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
    expect(machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'needs-proof' } })).toBe('Prove it’s you once on the console (a passkey, or the account password), and Solis-Core opens here.')
    expect(machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'no-device' } })).toBe('Sign this browser in on the console, and Solis-Core opens here.')
  })

  it('the machine’s own words when it turned this one away; a quiet one is asked again', () => {
    expect(machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'refused', message: 'This browser was forgotten there.' } })).toBe('Solis-Core: This browser was forgotten there.')
    expect(machineWhyWords(solis, { surface: 'page', trusted: null, block: { kind: 'offline' } })).toBe('Solis-Core isn’t answering right now. Try again in a moment.')
    expect(machineWhyWords(solis, { surface: 'desktop', trusted: true, block: null })).toBe('Solis-Core isn’t answering yet. It opens as soon as it does.')
  })

  it('a page with no way to other machines (a machine reached by its address): where it can be', () => {
    expect(machineWhyWords(solis, { surface: 'none', trusted: null, block: null })).toBe('Open console.cookrew.dev to go into Solis-Core from here.')
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

describe('under a machine’s name on the devices stop', () => {
  const m = (over: object = {}) => ({ name: 'Solis-Core', online: true, detail: 'listed' as const, ...over })
  it('says nothing for a machine that is read', () => {
    expect(machineSays(m({ detail: 'live' }), { surface: 'desktop', trusted: true })).toBeNull()
  })
  it('says the one thing to do for one that is not', () => {
    expect(machineSays(m({ online: false }), { surface: 'desktop', trusted: true })).toBe('Open Cookrew on Solis-Core.')
    expect(machineSays(m(), { surface: 'desktop', trusted: false, platform: 'darwin' })).toBe('Sign this Mac in again, above, to read it.')
    expect(machineSays(m(), { surface: 'desktop', trusted: false, platform: 'linux' })).toBe('Sign this machine in again, above, to read it.')
    expect(machineSays(m(), { surface: 'none', trusted: null })).toBe('Open console.cookrew.dev to read it.')
    expect(machineSays(m(), { surface: 'desktop', trusted: true })).toBe('Not answering yet.')
    expect(machineSays(m({ detail: 'connecting' }), { surface: 'desktop', trusted: true })).toBe('Reading…')
  })
})

