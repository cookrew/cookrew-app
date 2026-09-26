import { describe, expect, it } from 'vitest'
import {
  DOORS_MAX,
  dayLabel,
  doorHeldElsewhere,
  doorHeldSentence,
  doorHolderOf,
  doorMovedSentence,
  doorsAfterMove,
  isTeamSlug
} from '../src/shared/door-ownership'
import { V3_COPY } from '../src/shared/account-copy'
import { heldVerdict } from '../src/renderer/src/ShareOnSave'

/**
 * ONE NAME, ONE HOLDER — the rule, on its own.
 *
 * Three surfaces read this: the registry enforces it, the save sheet draws it,
 * and main decides on it whether to redial after being replaced. So the rule is
 * tested here once, with no registry, no React and no network — and the two
 * things it must never get wrong are the ones every test below is about: who
 * holds a name, and what the person is told about it.
 */

const desktops = [
  { deviceId: 'mac-1', name: 'MacBook Pro', doors: [{ team: 'alpha', since: 1_000 }] },
  { deviceId: 'mac-2', name: 'Mac Studio', doors: [{ team: 'beta', since: 2_000 }] },
  { deviceId: 'mac-3', name: 'Mac mini' }
]

describe('who holds a door', () => {
  it('names the OTHER Mac, with the day it took it', () => {
    expect(doorHeldElsewhere(desktops, 'alpha', 'mac-2')).toEqual({
      deviceId: 'mac-1',
      name: 'MacBook Pro',
      since: 1_000
    })
  })

  it('says nobody when the asking Mac is the holder', () => {
    // A Mac re-saving a team it already serves must not be asked to take the
    // door over from itself — which would be a sentence about a stranger,
    // naming the machine the person is sitting at.
    expect(doorHeldElsewhere(desktops, 'alpha', 'mac-1')).toBeNull()
  })

  it('says nobody for a free name, and for a desktop that has never claimed one', () => {
    expect(doorHeldElsewhere(desktops, 'gamma', 'mac-2')).toBeNull()
    expect(doorHeldElsewhere([desktops[2]], 'alpha', null)).toBeNull()
  })

  it('answers about this account only — a Mac with no account has no conflict', () => {
    expect(doorHeldElsewhere([], 'alpha', null)).toBeNull()
  })
})

describe('moving a door', () => {
  const at = 9_000

  it('takes it off the old holder and gives it to the new one', () => {
    expect(doorsAfterMove(desktops[0], 'alpha', 'mac-2', at)).toEqual([])
    expect(doorsAfterMove(desktops[1], 'alpha', 'mac-2', at)).toEqual([
      { team: 'beta', since: 2_000 },
      { team: 'alpha', since: at }
    ])
  })

  it('leaves a desktop the move does not touch alone — literally', () => {
    // Null, not an equal copy: every caller keeps the object it already has,
    // and the registry's own change detection is reference equality.
    expect(doorsAfterMove(desktops[2], 'alpha', 'mac-2', at)).toBeNull()
    expect(doorsAfterMove(desktops[1], 'gamma', 'mac-1', at)).toBeNull()
  })

  it('KEEPS THE ORIGINAL since when the holder re-claims what it already has', () => {
    // "served by MacBook Pro since Tue" is the sentence. A re-save that reset
    // the date would make a door held for a month read as claimed just now.
    expect(doorsAfterMove(desktops[0], 'alpha', 'mac-1', at)).toBeNull()
  })

  it('releases to nobody — a door that moved to a machine we cannot name', () => {
    expect(doorsAfterMove(desktops[0], 'alpha', null, at)).toEqual([])
  })

  it('leaves exactly one holder afterwards', () => {
    const moved = desktops.map((desktop) => {
      const doors = doorsAfterMove(desktop, 'alpha', 'mac-3', at)
      return doors === null ? desktop : { ...desktop, doors }
    })
    expect(doorHolderOf(moved, 'alpha')?.deviceId).toBe('mac-3')
    expect(moved.filter((d) => (d.doors ?? []).some((x) => x.team === 'alpha'))).toHaveLength(1)
  })
})

describe('a team slug, as a door name carries it', () => {
  it('takes what the hub takes', () => {
    expect(isTeamSlug('alpha')).toBe(true)
    expect(isTeamSlug('cookrew-alpha')).toBe(true)
    expect(isTeamSlug('a')).toBe(true)
  })

  it('refuses what would be refused later as a bad name', () => {
    // A slug that passes here and fails at the hub would be a claim filed for
    // a door that can never open.
    for (const bad of ['', '-alpha', 'alpha-', 'Alpha', 'al pha', '@drej/alpha', 'a'.repeat(65)]) {
      expect(isTeamSlug(bad)).toBe(false)
    }
    for (const bad of [undefined, null, 42, {}]) expect(isTeamSlug(bad)).toBe(false)
  })

  it('bounds the list, because a claim list is a list a stranger cannot flood but a Mac can', () => {
    expect(DOORS_MAX).toBeGreaterThan(8)
  })
})

describe('the sentences', () => {
  const day = 86_400_000

  it('are the copy table’s, filled — never written here', () => {
    // The table is the source (V3-07). A second spelling of D14 on the desktop
    // and the web is how one of them ends up saying something the other does
    // not, about a door that is already confusing.
    expect(doorHeldSentence('alpha', { deviceId: 'x', name: 'MacBook Pro', since: 0 }, 0)).toBe(
      V3_COPY['d14.held']
        .replace('{door}', 'alpha')
        .replace('{device}', 'MacBook Pro')
        .replace('{day}', 'today')
    )
    expect(doorMovedSentence('alpha', 'Mac Studio')).toBe(
      V3_COPY['d14.moved'].replace('{door}', 'alpha').replace('{device}', 'Mac Studio')
    )
  })

  it('name a day a person can use', () => {
    const now = new Date(2026, 8, 18, 11, 0, 0).getTime()
    expect(dayLabel(now - 60_000, now)).toBe('today')
    expect(dayLabel(now - day, now)).toBe('yesterday')
    // Tuesday, three days before a Friday.
    expect(dayLabel(now - 3 * day, now)).toBe('Tue')
    // Beyond a week "Tuesday" stops being an answer — which Tuesday?
    expect(dayLabel(now - 20 * day, now)).toBe('Aug 29')
  })

  it('says the whole sentence, ending with the rule', () => {
    const said = doorHeldSentence('alpha', { deviceId: 'x', name: 'MacBook Pro', since: 0 }, 0)
    expect(said).toContain('alpha is served by MacBook Pro')
    expect(said).toContain('A door has one holder.')
    // No code, no status, no word we use for our own machinery.
    expect(said).not.toMatch(/error|invalid|409|name-taken/i)
  })
})

describe('what SAVE does when another Mac holds the name', () => {
  const held = { deviceId: 'mac-1', name: 'MacBook Pro', since: 0 }

  it('is unaffected when nobody else holds it', () => {
    expect(heldVerdict(null, 'keep')).toBe('clear')
    expect(heldVerdict(null, 'take-over')).toBe('clear')
  })

  it('KEEPS THEIRS by saving and publishing nothing', () => {
    // The default answer, and the one that cannot cost anybody a door by being
    // chosen without reading: the other Mac goes on serving.
    expect(heldVerdict(held, 'keep')).toBe('save-only')
  })

  it('TAKES OVER by going ahead — the relay moves the name', () => {
    expect(heldVerdict(held, 'take-over')).toBe('clear')
  })

  it('RENAME waits for a different name rather than taking the door', () => {
    expect(heldVerdict(held, 'rename')).toBe('rename-first')
  })
})
