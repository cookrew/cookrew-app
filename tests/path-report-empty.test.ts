// THE REPORT THE OWNER GOT WAS NOT THE RACE THE OWNER SAW.
//
// THE INCIDENT, 2026-09-08. The Mac's /api/path/reports held two reports from
// "Chrome on macOS · RELAY · perm=prompt · Chrome 152" whose `attempts` array
// was EMPTY, while the panel on that very browser was showing one candidate
// row: `192.168.2.40:8643 refused by the browser before connecting — 32 ms`.
// Two records of a race that tried nothing, and no record of the race that
// found something.
//
// BOTH HALVES CAME FROM THE SAME PLACE. Under permission 'prompt' the timer's
// race is not allowed to raise a dialog, so every LOCAL candidate is filtered
// out and the switcher reports zero rows — deliberately, so the panel does not
// describe a network the phone may no longer be on. That empty note went out
// as a POST, and in doing so it CLAIMED THE FLOOR: the reporter's five-second
// minimum gap is measured from the last report it tried to send, so the race a
// person started by pressing ALLOW — the one with the row in it — landed
// inside that window and was dropped.
//
// So a report with no attempts is not sent, and not counted: it describes no
// race, it can teach nobody anything, and its only observable effect was to
// suppress the report that mattered.

import { describe, expect, it } from 'vitest'
import {
  PATH_REPORT_MIN_GAP_MS,
  createPathReporter,
  reportedAttempts
} from '../src/renderer/src/path/report'
import {
  switchPlaneIfBetter,
  type PlaneAttempt,
  type PlaneSwitchDeps
} from '../src/renderer/src/path/plane-switch'
import type { LocalNetworkState } from '../src/renderer/src/local-network'
import type { PathAttempt } from '../src/renderer/src/path-attempts'
import type { DataPlane } from '../src/renderer/src/data-plane'
import type { PathReport } from '../src/shared/path-report'
import type { ReachCardLite } from '../src/renderer/src/path/switch'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`
const RELAY: DataPlane = { origin: '', kind: 'relay' }

const report = (attempts: readonly PathAttempt[], over: Partial<PathReport> = {}): PathReport => ({
  at: 1_800_000_000_000,
  plane: 'RELAY',
  permission: 'prompt',
  browser: 'Chrome 152',
  attempts: reportedAttempts(attempts),
  ...over
})

const blockedRow: PathAttempt = {
  name: '192.168.2.40:8643',
  outcome: 'blocked',
  ms: 32,
  plane: 'LAN',
  chosen: false,
  hint: 'none'
}

describe('a report with nothing in it', () => {
  it('is never sent — it describes no race', async () => {
    const sent: PathReport[] = []
    const tell = createPathReporter({
      post: async (one) => void sent.push(one),
      now: () => 0
    })
    expect(await tell(report([]))).toBe(false)
    expect(sent).toEqual([])
  })

  it('does not claim the floor the next real report has to clear', async () => {
    // THIS is the bug: the empty report set `lastAt`, and the ALLOW-press race
    // that followed it a second later was dropped as a duplicate of a moment.
    const sent: PathReport[] = []
    const clock = { ms: 0 }
    const tell = createPathReporter({
      post: async (one) => void sent.push(one),
      now: () => clock.ms
    })
    expect(await tell(report([]))).toBe(false)
    clock.ms = PATH_REPORT_MIN_GAP_MS - 1
    expect(await tell(report([blockedRow]))).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].attempts[0]).toMatchObject({ name: '192.168.2.40:8643', outcome: 'blocked' })
  })

  it('leaves every other guard exactly where it was', async () => {
    const sent: PathReport[] = []
    const clock = { ms: 0 }
    const tell = createPathReporter({
      post: async (one) => void sent.push(one),
      now: () => clock.ms
    })
    expect(await tell(report([blockedRow]))).toBe(true)
    clock.ms = PATH_REPORT_MIN_GAP_MS - 1
    expect(await tell(report([blockedRow], { plane: 'LAN' }))).toBe(false)
    clock.ms = 60_000
    // The same race again is still not news, however much later it is observed.
    expect(await tell(report([blockedRow]))).toBe(false)
    expect(sent).toHaveLength(1)
  })
})

describe('the two races the owner actually ran, wired as the companion wires them', () => {
  /** The switcher and the reporter, joined by `note` exactly as companion.ts does. */
  const companion = (): {
    readonly race: (pressed: boolean) => Promise<void>
    readonly sent: readonly PathReport[]
    readonly panel: () => readonly PlaneAttempt[]
  } => {
    const sent: PathReport[] = []
    const clock = { ms: 0 }
    let panel: readonly PlaneAttempt[] = []
    const tell = createPathReporter({
      post: async (one) => void sent.push(one),
      now: () => clock.ms
    })
    const permission = async (): Promise<LocalNetworkState> => 'prompt'
    const race = async (pressed: boolean): Promise<void> => {
      clock.ms += 1_000
      let pending: Promise<boolean> = Promise.resolve(false)
      const deps: PlaneSwitchDeps = {
        plane: () => RELAY,
        card: async (): Promise<ReachCardLite> => ({
          deviceId: DEVICE,
          lan: [],
          tailnet: null,
          trusted: [LAN]
        }),
        // The measured fact: refused in 32 ms with the hint and again without.
        hello: async () => ({
          ok: false,
          kind: 'blocked',
          ms: 32,
          attempts: [
            { hint: 'local', kind: 'blocked', ms: 32 },
            { hint: 'none', kind: 'blocked', ms: 30 }
          ]
        }),
        verify: async () => false,
        adopt: () => undefined,
        nonce: () => 'a-nonce',
        permission,
        mayPrompt: () => pressed,
        note: (rows) => {
          panel = rows
          pending = tell(report(rows as readonly PathAttempt[]))
        }
      }
      await switchPlaneIfBetter(deps)
      await pending
    }
    return { race, sent, panel: () => panel }
  }

  it('sends exactly one report, and it is the race the panel is showing', async () => {
    const phone = companion()
    // The timer's race, which is not allowed to raise a dialog and so tries
    // nothing at all. It used to post an empty report and swallow the floor.
    await phone.race(false)
    expect(phone.panel()).toEqual([])
    expect(phone.sent).toEqual([])

    // The reader presses ALLOW. One candidate, refused both ways.
    await phone.race(true)
    expect(phone.panel()).toHaveLength(1)
    expect(phone.sent).toHaveLength(1)
    expect(phone.sent[0].attempts).toEqual([
      { name: '192.168.2.40:8643', outcome: 'blocked', ms: 32, hint: 'none' }
    ])
  })

  it('does not send the timer races that follow it either', async () => {
    const phone = companion()
    await phone.race(false)
    await phone.race(true)
    await phone.race(false)
    await phone.race(false)
    expect(phone.sent).toHaveLength(1)
  })
})
