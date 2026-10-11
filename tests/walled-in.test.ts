// WHEN NOTHING THIS APP CAN SEND REACHES THE LAN, THE BADGE SAYS SO — and
// names the fix, instead of a Mac that is three metres away.
import { describe, expect, it } from 'vitest'
import { walledIn } from '../src/renderer/src/path/hint-evidence'
import { pathBadgeView, RELAY_BLOCKED_SENTENCE, RELAY_REFUSED_SENTENCE, RELAY_WALLED_SENTENCE } from '../src/shared/path-badge'
import {
  pathAttempts,
  recordAttempts,
  recordProbes,
  resetPathAttempts,
  type PathAttempt,
  type PathProbe
} from '../src/renderer/src/path-attempts'
import { readFileSync } from 'node:fs'

const NAME = '192-168-2-40.e03994f9-138d-80ff-9377-475cc59142b4.d.cookrew.dev:8643'
const row = (outcome: PathAttempt['outcome']): PathAttempt => ({ name: '192.168.2.40:8643', outcome, ms: 2501, plane: 'LAN', chosen: false })
const knock = (kind: PathProbe['kind'], outcome: PathProbe['outcome']): PathProbe => ({ kind, name: NAME, outcome, ms: 2501 })
const dead = [knock('socket', 'timeout'), knock('image', 'timeout'), knock('opaque', 'timeout')]

describe('walledIn', () => {
  it('is iOS, no permission to grant, rows that never answered, and every knock dead', () => {
    expect(walledIn({ ios: true, permission: 'unsupported', attempts: [row('timeout'), row('blocked')], probes: dead })).toBe(true)
  })
  it('is not any of those alone', () => {
    expect(walledIn({ ios: false, permission: 'unsupported', attempts: [row('timeout')], probes: dead })).toBe(false)
    expect(walledIn({ ios: true, permission: 'prompt', attempts: [row('timeout')], probes: dead })).toBe(false)
    expect(walledIn({ ios: true, permission: 'unsupported', attempts: [], probes: dead })).toBe(false)
    // Knocks still out: not yet a verdict.
    expect(walledIn({ ios: true, permission: 'unsupported', attempts: [row('timeout')], probes: [] })).toBe(false)
    // One knock got in: the page is going home, not walled.
    expect(walledIn({ ios: true, permission: 'unsupported', attempts: [row('timeout')], probes: [knock('socket', 'answered')] })).toBe(false)
    // A row that answered or was refused by a cert is a different story.
    expect(walledIn({ ios: true, permission: 'unsupported', attempts: [row('timeout'), row('network')], probes: dead })).toBe(false)
  })
})

describe('the knocks in the attempts store', () => {
  it('belong to the race whose rows were recorded, and a new race empties them', () => {
    resetPathAttempts()
    recordAttempts([row('timeout')], 'RELAY')
    expect(pathAttempts().probes).toEqual([])
    recordProbes(dead)
    expect(pathAttempts().probes).toEqual(dead)
    recordAttempts([row('timeout')], 'RELAY')
    expect(pathAttempts().probes).toEqual([])
    resetPathAttempts()
  })
})

describe('the badge sentence when walled in', () => {
  const base = { origin: 'https://cookrew.dev', link: 'live' as const, relayed: true, plane: 'RELAY' as const }
  it('names iOS and the two fixes, never the Mac\'s whereabouts', () => {
    const view = pathBadgeView({ ...base, localNetwork: 'unsupported', walledIn: true })
    expect(view.word).toBe('RELAY')
    expect(view.sentence).toBe(RELAY_WALLED_SENTENCE)
    expect(view.sentence).not.toContain('not on this network')
    expect(view.sentence).toContain('Tailscale')
    expect(view.sentence).toContain('Safari')
  })
  it('outranks a measured refusal and yields to a decided one and to an unpublished Mac', () => {
    expect(pathBadgeView({ ...base, walledIn: true, refusedByBrowser: true }).sentence).toBe(RELAY_WALLED_SENTENCE)
    expect(pathBadgeView({ ...base, walledIn: true, localNetwork: 'denied' }).sentence).toBe(RELAY_REFUSED_SENTENCE)
    expect(pathBadgeView({ ...base, walledIn: true, unpublished: 'session-expired' }).sentence).toContain('sign-in ended')
    expect(pathBadgeView({ ...base, refusedByBrowser: true }).sentence).toBe(RELAY_BLOCKED_SENTENCE)
  })
  it('is history on a direct plane', () => {
    expect(pathBadgeView({ ...base, plane: 'LAN', walledIn: true }).sentence).toBe('Direct over this Wi-Fi.')
  })
})

describe('the wiring', () => {
  it('the badge reads the knocks from the store the companion fills', () => {
    const link = readFileSync('src/renderer/src/path-link.ts', 'utf8')
    expect(link).toContain('walledIn: walledIn({')
    expect(link).toContain('probes: pathAttempts().probes')
    const companion = readFileSync('src/renderer/src/path/companion.ts', 'utf8')
    expect(companion.indexOf('recordProbes(probes)')).toBeLessThan(companion.indexOf('await tellTheDesktop({ ...report, probes })'))
    const badge = readFileSync('src/renderer/src/PathBadge.tsx', 'utf8')
    expect(badge).not.toContain('DirectOfferLine')
  })
})
