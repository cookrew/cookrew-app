import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { machineWhyShows, machineWhyWords, machineSays } from '../src/renderer/src/zoom/machine-why'

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
    expect(machineWhyWords({ name: 'Solis-Core', online: false, signedIn: true }, { surface: 'desktop', trusted: true, block: null })).toBe('Solis-Core is offline. It opens here once it is back.')
  })

  it('a machine that is SIGNED OUT is not told to open Cookrew: it is told to sign in, in its own platform’s way', () => {
    // Owner 2026-11-11: Cookrew was open on Solis-Core; it had not signed in since the registry moved.
    const out = { name: 'Solis-Core', online: false, signedIn: false }
    for (const surface of ['desktop', 'page'] as const) {
      expect(machineWhyWords({ ...out, os: 'linux' }, { surface, trusted: null, block: null })).toBe('Solis-Core is signed out. Run cookrew login on it, and it opens here.')
      expect(machineWhyWords({ ...out, os: null }, { surface, trusted: null, block: null })).toBe('Solis-Core is signed out. Run cookrew login on it, and it opens here.')
      expect(machineWhyWords({ ...out, name: 'Studio Mac', os: 'darwin' }, { surface, trusted: null, block: null })).toBe('Studio Mac is signed out. Open Cookrew on it and sign in, and it opens here.')
    }
    expect(machineSays({ ...out, os: 'linux', detail: 'listed' }, { surface: 'desktop', trusted: true })).toBe('Solis-Core is signed out. Run cookrew login on it.')
    expect(machineSays({ ...out, name: 'Studio Mac', os: 'darwin', detail: 'listed' }, { surface: 'page', trusted: null })).toBe('Studio Mac is signed out. Open Cookrew on it and sign in.')
    expect(machineSays({ ...out, name: 'Desk PC', os: 'win32', detail: 'listed' }, { surface: 'desktop', trusted: true })).toBe('Desk PC is signed out. Open Cookrew on it and sign in.')
    // Signed in, or a registry that does not say: the app is simply not running there.
    expect(machineSays({ name: 'Solis-Core', online: false, signedIn: true, detail: 'listed' }, { surface: 'desktop', trusted: true })).toBe('Open Cookrew on Solis-Core.')
    expect(machineSays({ name: 'Solis-Core', online: false, detail: 'listed' }, { surface: 'desktop', trusted: true })).toBe('Open Cookrew on Solis-Core.')
    // A machine that holds its line is not signed out, whatever an older row said.
    expect(machineSays({ name: 'Solis-Core', online: true, signedIn: false, detail: 'live' }, { surface: 'desktop', trusted: true })).toBeNull()
  })

  it('a desktop that has not proved itself: the one button', () => {
    expect(machineWhyWords(solis, { surface: 'desktop', trusted: false, block: null, platform: 'darwin' })).toBe('Press “Prove it’s you on this Mac to see your other machines” below, and Solis-Core opens here.')
    expect(machineWhyWords(solis, { surface: 'desktop', trusted: false, block: null, platform: 'linux' })).toBe('Press “Prove it’s you on this machine to see your other machines” below, and Solis-Core opens here.')
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
  it('on the console, a machine too old to be read says to update it, before anything else it could be asked', () => {
    for (const block of [null, { kind: 'needs-proof' }, { kind: 'no-device' }] as const) {
      expect(machineSays(m({ appVersion: '0.5.8' }), { surface: 'page', floor: true, trusted: null, block })).toBe('Update Cookrew on Solis-Core.')
    }
    expect(machineSays(m({ appVersion: null }), { surface: 'page', floor: true, trusted: null })).toBe('Update Cookrew on Solis-Core.')
    expect(machineSays(m({ appVersion: '0.6.0' }), { surface: 'page', floor: true, trusted: null })).toBe('Not answering yet.')
    // Offline comes first: an update cannot be asked of a machine that is not there.
    expect(machineSays(m({ appVersion: '0.5.8', online: false }), { surface: 'page', floor: true, trusted: null })).toBe('Open Cookrew on Solis-Core.')
    // A caller that does not know the version is not told to update.
    expect(machineSays(m(), { surface: 'page', floor: true, trusted: null })).toBe('Not answering yet.')
    // A machine's own phone page is a page too, and enters no other machine: the floor is the console's, said only there.
    expect(machineSays(m({ appVersion: '0.5.8' }), { surface: 'page', trusted: null })).toBe('Not answering yet.')
    // The desktop app reaches machines with a machine key, not the pass: the floor is not its rule.
    expect(machineSays(m({ appVersion: '0.5.8' }), { surface: 'desktop', trusted: true })).toBe('Not answering yet.')
    expect(machineSays(m({ appVersion: '0.5.8', detail: 'live' }), { surface: 'desktop', trusted: true })).toBeNull()
    // The view's own machine carries the version, or none of this would ever be said.
    // (zoom-model.ts · machineViewOf, kept in machine-view.ts so the console's first load can draw it.)
    const model = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'zoom', 'machine-view.ts'), 'utf8')
    expect(model).toContain('appVersion: m.appVersion ?? null,')
    const fleet = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'zoom', 'use-zoom-fleet.ts'), 'utf8')
    expect(fleet.slice(fleet.indexOf('export function fleetViewOf('))).toContain('appVersion: m.appVersion,')
    // And a tap on it asks it nothing: the view decides that before it asks (ZoomView · whyNot).
    const view = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'zoom', 'ZoomView.tsx'), 'utf8')
    const tap = view.slice(view.indexOf('async function whyNot('))
    expect(tap.indexOf('machineTooOld(m, scopeNeedsMachine())')).toBeGreaterThan(-1)
    expect(tap.indexOf('machineTooOld(m, scopeNeedsMachine())')).toBeLessThan(tap.indexOf('api.machineFleetOf?.(m.id)'))
    expect(machineWhyWords({ name: 'Solis-Core', online: true, appVersion: '0.5.8' }, { surface: 'page', floor: true, trusted: null, block: null })).toBe('Update Cookrew on Solis-Core, and it opens here.')
  })

  it('says nothing for a machine that is read', () => {
    expect(machineSays(m({ detail: 'live' }), { surface: 'desktop', trusted: true })).toBeNull()
  })
  it('says the one thing to do for one that is not', () => {
    expect(machineSays(m({ online: false }), { surface: 'desktop', trusted: true })).toBe('Open Cookrew on Solis-Core.')
    expect(machineSays(m(), { surface: 'desktop', trusted: false, platform: 'darwin' })).toBe('Prove it’s you on this Mac, below, to read it.')
    expect(machineSays(m(), { surface: 'desktop', trusted: false, platform: 'linux' })).toBe('Prove it’s you on this machine, below, to read it.')
    expect(machineSays(m(), { surface: 'none', trusted: null })).toBe('Open console.cookrew.dev to read it.')
    expect(machineSays(m(), { surface: 'desktop', trusted: true })).toBe('Not answering yet.')
    expect(machineSays(m({ detail: 'connecting' }), { surface: 'desktop', trusted: true })).toBe('Reading…')
  })
  it('on a page that enters machines with the account’s pass, says what stood in the way the last time it asked', () => {
    expect(machineSays(m(), { surface: 'page', trusted: null, block: { kind: 'needs-proof' } })).toBe('Prove it’s you on the console to read it.')
    expect(machineSays(m(), { surface: 'page', trusted: null, block: { kind: 'no-device' } })).toBe('Sign this browser in on the console to read it.')
    expect(machineSays(m(), { surface: 'page', trusted: null, block: { kind: 'refused', message: 'Remote access is off on this Mac.' } })).toBe('Solis-Core says: Remote access is off on this Mac.')
    expect(machineSays(m(), { surface: 'page', trusted: null, block: { kind: 'offline' } })).toBe('Not answering yet.')
  })
})
