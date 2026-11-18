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
import { PATH_REPORT_MIN_GAP_MS, createPathReporter } from '../src/renderer/src/path/report'
import type { PathReport, PathReportAttempt, PathReportProbe } from '../src/shared/path-report'

const report = (attempts: readonly PathReportAttempt[], over: Partial<PathReport> = {}): PathReport => ({
  at: 1_800_000_000_000,
  plane: 'RELAY',
  permission: 'prompt',
  browser: 'Chrome 152',
  attempts,
  ...over
})

const blockedRow: PathReportAttempt = {
  name: '192.168.2.40:8643',
  outcome: 'blocked',
  ms: 32,
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

describe('a race whose only row is the WebRTC link', () => {
  it('is a fact, and is sent: since the names went (2026-11-16) a race has no other rows', async () => {
    const sent: PathReport[] = []
    const tell = createPathReporter({
      post: async (one) => void sent.push(one),
      now: () => 0
    })
    const probe: PathReportProbe = { kind: 'rtc', name: '192.168.2.40', outcome: 'answered', ms: 420 }
    expect(await tell(report([], { probes: [probe] }))).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].attempts).toEqual([])
  })
})
