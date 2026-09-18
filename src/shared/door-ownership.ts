import { accountCopy } from './account-copy'

/**
 * ONE NAME, ONE HOLDER — and the person is told which Mac holds it.
 *
 * Two Macs of one account, cloned from the same repo, save the same team and
 * derive the same slug. Until now the second one simply never opened: the hub
 * refuses a duplicate name (`name-taken`, relay-hub.ts) because a takeover is
 * how somebody who learns a name steals the traffic meant for it. That refusal
 * is RIGHT and stays — what was missing is that nobody was told. The door did
 * not appear, no sentence said why, and the owner was left with a team that
 * saved and a URL that answered from the wrong machine.
 *
 * So the rule becomes explicit, and it is stated in three places that must
 * agree:
 *
 *   the ACCOUNT knows who holds what — desktops[].doors[] at the registry, so
 *     @drej/alpha has exactly one holder across every Mac of @drej;
 *   the SAVE SHEET asks before the hub can refuse, because a conflict found at
 *     save time is a choice and a conflict found at dial time is a failure;
 *   the HUB moves the name when the account says to, and tells the machine it
 *     was taken from — which is the only reason that machine can stop rather
 *     than fight for it.
 *
 * THE URL NEVER CHANGES. @drej/alpha points at whoever holds it, the way a
 * phone number points at whichever handset has the SIM. That is the whole
 * point of moving a door rather than renaming one: the link an owner already
 * handed out keeps working.
 *
 * WHY THIS FILE IS SHARED. The registry enforces the rule, the desktop's save
 * sheet draws it, and main decides whether to redial after being superseded.
 * Three copies of "who holds alpha" is three chances to disagree about it, and
 * the disagreement would be invisible: one surface would say the door is
 * yours while another quietly served it from somewhere else.
 */

/**
 * A team slug, as a door name carries it — the second half of `@handle/team`.
 * Exactly the shape relay-hub.ts accepts, so a name that passes here cannot be
 * refused as `bad-name` later.
 */
const TEAM_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export const isTeamSlug = (value: unknown): value is string =>
  typeof value === 'string' && TEAM_SLUG.test(value)

/** More doors than one Mac serves, and far fewer than a list worth flooding. */
export const DOORS_MAX = 64

/** A door this desktop holds, and since when. `since` is the registry's. */
export interface DoorClaim {
  team: string
  since: number
}

/** A desktop, reduced to what this rule reads. Both wire shapes satisfy it. */
export interface DoorDesktop {
  deviceId: string
  name: string
  doors?: readonly DoorClaim[]
}

/** The Mac holding a door, when it is not this one. */
export interface DoorHolder {
  deviceId: string
  name: string
  since: number
}

/**
 * WHO ELSE HOLDS THIS NAME — null when nobody does, or when this Mac does.
 *
 * `mine` is excluded rather than compared against, because a Mac re-saving a
 * team it already serves is the ordinary case and must not be asked to take
 * over from itself. The first holder wins the sentence when the list somehow
 * carries two: the rule below keeps that from happening, and a screen that
 * named both would be describing a bug rather than a choice.
 */
export function doorHeldElsewhere(
  desktops: readonly DoorDesktop[],
  team: string,
  mine: string | null
): DoorHolder | null {
  for (const desktop of desktops) {
    if (desktop.deviceId === mine) continue
    const claim = (desktop.doors ?? []).find((door) => door.team === team)
    if (claim !== undefined) {
      return { deviceId: desktop.deviceId, name: desktop.name, since: claim.since }
    }
  }
  return null
}

/**
 * THE ONE-HOLDER RULE, for one desktop at a time. Null means "unchanged", so
 * a caller can keep the object it already has rather than rebuilding it.
 *
 * `toDeviceId` is the machine the door is moving TO; every other desktop drops
 * the claim, the new one gains it at `now`, and a machine that already held it
 * keeps its original `since` — the sentence says "since Tue", and a takeover
 * that reset the date would make every re-save look like a fresh claim.
 * `toDeviceId` of null releases the claim without giving it to anybody, which
 * is what happens when a door moves to a machine this account has no desktop
 * record for yet.
 *
 * Written here rather than inside the registry's store because the desktop
 * applies the same move to its own cached profile after a takeover, and a
 * second implementation of "one holder" would be a second answer to it.
 */
export function doorsAfterMove(
  desktop: DoorDesktop,
  team: string,
  toDeviceId: string | null,
  now: number
): readonly DoorClaim[] | null {
  const held = desktop.doors ?? []
  const has = held.some((door) => door.team === team)
  if (desktop.deviceId === toDeviceId) {
    return has ? null : [...held, { team, since: now }]
  }
  return has ? held.filter((door) => door.team !== team) : null
}

/** Which desktop holds `team` right now, if any. */
export function doorHolderOf<T extends DoorDesktop>(
  desktops: readonly T[],
  team: string
): T | null {
  return desktops.find((desktop) => (desktop.doors ?? []).some((door) => door.team === team)) ?? null
}

/**
 * The day a sentence names — "Tue", not a timestamp.
 *
 * A person reading "served by MacBook Pro since Tue" is deciding whether that
 * was them, this week. Beyond a week the weekday stops being an answer (which
 * Tuesday?) and the date is the shorter thing to say.
 */
export function dayLabel(at: number, now: number = Date.now()): string {
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  const date = new Date(at)
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const startOfDay = (at: number): number => {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** D14 held: "alpha is served by MacBook Pro since Tue. A door has one holder." */
export function doorHeldSentence(team: string, holder: DoorHolder, now: number = Date.now()): string {
  return accountCopy('d14.held', { door: team, device: holder.name, day: dayLabel(holder.since, now) })
}

/** D14 moved: "alpha moved to Mac Studio. This Mac stopped serving it." */
export function doorMovedSentence(team: string, by: string): string {
  return accountCopy('d14.moved', { door: team, device: by })
}
