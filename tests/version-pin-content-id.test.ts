import { describe, expect, it } from 'vitest'
import {
  cutTeamVersion,
  cutVersionPin,
  detectVersionCollisions,
  pinIdentity,
  samePinIdentity,
  type VersionPinRecord
} from '../src/shared/version-pin'

/**
 * S1c — THE PIN'S IDENTITY IS ITS CONTENT, NOT ITS NUMBER.
 *
 * `nextVersion` is highest+1 over LOCAL records, so two machines offline both
 * cut "V2" with different content. These pin the property that saves a session
 * from that: identity is the content id, and two offline "V2"s are a DETECTED
 * collision rather than a silent substitution.
 */

const rec = (over: Partial<VersionPinRecord>): VersionPinRecord => ({
  version: 1,
  atIndex: 1,
  scrollLine: 0,
  cutAt: 0,
  ...over
})

describe('pinIdentity — content address, with a legacy fallback', () => {
  it('is the content id when the pin has one', () => {
    expect(pinIdentity(rec({ version: 2, pinId: 'sha256:abc' }))).toBe('sha256:abc')
  })

  it('falls back to the version label for a legacy pin with no id', () => {
    expect(pinIdentity(rec({ version: 2 }))).toBe('v2')
  })

  it('distinguishes two same-numbered pins by content, and matches same content', () => {
    const a = rec({ version: 2, pinId: 'sha256:aaa' })
    const b = rec({ version: 2, pinId: 'sha256:bbb' })
    const aAgain = rec({ version: 2, pinId: 'sha256:aaa', atIndex: 9 })
    expect(samePinIdentity(a, b)).toBe(false) // same number, different bytes
    expect(samePinIdentity(a, aAgain)).toBe(true) // same bytes, different cut point
  })
})

describe('cutVersionPin / cutTeamVersion carry the content id through', () => {
  it('stores a pinId when given one, and omits it when not (presence question)', () => {
    const withId = cutVersionPin([], { atIndex: 1, scrollLine: 0, cutAt: 0, pinId: 'sha256:x' })
    const without = cutVersionPin([], { atIndex: 1, scrollLine: 0, cutAt: 0 })
    expect(withId.pinId).toBe('sha256:x')
    expect('pinId' in without).toBe(false)
  })

  it('gives every member of a team version the SAME content id (one tuple, one identity)', () => {
    const cut = cutTeamVersion(
      [
        { terminalId: 't1', pins: [], atIndex: 3, scrollLine: 10 },
        { terminalId: 't2', pins: [], atIndex: 5, scrollLine: 20 }
      ],
      { cutAt: 0, pinId: 'sha256:team' }
    )
    expect(cut.members.map((m) => m.pin.pinId)).toEqual(['sha256:team', 'sha256:team'])
  })
})

describe('detectVersionCollisions — the sync conflict S1c makes visible', () => {
  it('flags a version number carrying two different content ids', () => {
    const merged = [
      rec({ version: 1, pinId: 'sha256:v1' }),
      rec({ version: 2, pinId: 'sha256:laptop' }),
      rec({ version: 2, pinId: 'sha256:desktop' })
    ]
    expect(detectVersionCollisions(merged)).toEqual([
      { version: 2, pinIds: ['sha256:desktop', 'sha256:laptop'] }
    ])
  })

  it('does not flag one version cut twice into the SAME content', () => {
    const merged = [
      rec({ version: 2, pinId: 'sha256:same' }),
      rec({ version: 2, pinId: 'sha256:same' })
    ]
    expect(detectVersionCollisions(merged)).toEqual([])
  })

  it('never invents a collision from legacy records that carry no id', () => {
    // Two "V2"s with no pinId cannot be PROVEN to differ, so raising a conflict
    // would be a false alarm. Absence is tolerated, never treated as evidence.
    const merged = [rec({ version: 2 }), rec({ version: 2 })]
    expect(detectVersionCollisions(merged)).toEqual([])
  })
})
