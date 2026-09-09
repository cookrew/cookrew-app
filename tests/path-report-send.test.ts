// THE PHONE TELLS THE MAC, SO NOBODY HAS TO PHOTOGRAPH A PHONE SCREEN.
//
// The owner's panel showed four LAN candidates saying "no answer" and a
// 13,328 ms relay round trip, and the only way anybody else could look at it
// was a photograph — which cannot be diffed, cannot be asked a follow-up
// question, and stops existing when the sheet is closed. So each race is
// posted to the Mac it was trying to reach.
//
// Three properties this must never lose: ONE post per race (a diagnostic that
// becomes traffic is a bug), NO token and NO URL anywhere in the body (the
// credential belongs in the Authorization header and nowhere else), and a
// failure that stays a non-event — this is sent over the very plane it is
// complaining about.

import { describe, expect, it } from 'vitest'
import {
  PATH_REPORT_MIN_GAP_MS,
  createPathReporter,
  postPathReport,
  reportedAttempts
} from '../src/renderer/src/path/report'
import type { PathAttempt } from '../src/renderer/src/path-attempts'
import type { PathReport } from '../src/shared/path-report'

const TOKEN = 'a-very-secret-pairing-token'

const attempt = (over: Partial<PathAttempt> = {}): PathAttempt => ({
  name: '192.168.1.24:8643',
  outcome: 'blocked',
  ms: 1,
  plane: 'LAN',
  chosen: false,
  ...over
})

const report = (over: Partial<PathReport> = {}): PathReport => ({
  at: 1_800_000_000_000,
  plane: 'RELAY',
  permission: 'denied',
  browser: 'Chrome 142',
  attempts: reportedAttempts([attempt({ detail: 'TypeError: Failed to fetch' })]),
  ...over
})

describe('the rows on the wire', () => {
  it('carries what happened, including the status and the browser’s own words', () => {
    const rows = reportedAttempts([
      attempt({ outcome: 'http', status: 421, ms: 12 }),
      attempt({ name: '10.0.0.9:8643', outcome: 'timeout', ms: 800 })
    ])
    expect(rows[0]).toEqual({ name: '192.168.1.24:8643', outcome: 'http', status: 421, ms: 12 })
    expect(rows[1]).toEqual({ name: '10.0.0.9:8643', outcome: 'timeout', ms: 800 })
  })

  it('drops the two fields that are the panel’s business, not the Mac’s', () => {
    const [row] = reportedAttempts([attempt({ chosen: true })])
    expect(row).not.toHaveProperty('plane')
    expect(row).not.toHaveProperty('chosen')
  })

  it('is bounded, so a strange card cannot post an unbounded body', () => {
    const many = Array.from({ length: 40 }, (_, i) => attempt({ name: `10.0.0.${i}:8643` }))
    expect(reportedAttempts(many)).toHaveLength(12)
  })
})

describe('one POST per race', () => {
  const reporterOn = (
    sent: PathReport[],
    clock: { ms: number },
    post?: (report: PathReport) => Promise<void>
  ): ((report: PathReport) => Promise<boolean>) =>
    createPathReporter({
      post:
        post ??
        (async (one) => {
          sent.push(one)
        }),
      now: () => clock.ms
    })

  it('sends the race it is given', async () => {
    const sent: PathReport[] = []
    const clock = { ms: 0 }
    expect(await reporterOn(sent, clock)(report())).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].attempts[0].outcome).toBe('blocked')
  })

  it('drops a second report that lands inside the floor under the gap', async () => {
    // Pressing ALLOW starts a race beside the timer's, and both describe the
    // same moment. Races themselves are a minute apart, so this only ever
    // suppresses a duplicate.
    const sent: PathReport[] = []
    const clock = { ms: 0 }
    const tell = reporterOn(sent, clock)
    expect(await tell(report())).toBe(true)
    clock.ms = PATH_REPORT_MIN_GAP_MS - 1
    expect(await tell(report({ plane: 'LAN' }))).toBe(false)
    clock.ms = PATH_REPORT_MIN_GAP_MS
    expect(await tell(report({ plane: 'LAN' }))).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('drops a race identical to the one before it, however much later', async () => {
    // A phone denied the local network runs the same race every minute for as
    // long as it is on that Wi-Fi. Reporting each one would write 1,440
    // identical lines a day to the desktop's console and fill a twenty-deep
    // buffer with twenty copies of one fact.
    const sent: PathReport[] = []
    const clock = { ms: 0 }
    const tell = reporterOn(sent, clock)
    expect(await tell(report({ at: 1 }))).toBe(true)
    clock.ms = 60_000
    expect(await tell(report({ at: 2 }))).toBe(false)
    clock.ms = 120_000
    expect(await tell(report({ at: 3, permission: 'granted' }))).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('offers an undelivered report again, rather than deduplicating it away', async () => {
    // A refused post is not a report the desktop has; remembering it as one
    // would lose the very race the owner is trying to look at.
    const clock = { ms: 0 }
    let refuse = true
    const sent: PathReport[] = []
    const tell = createPathReporter({
      post: async (one) => {
        if (refuse) throw new Error('503')
        sent.push(one)
      },
      now: () => clock.ms
    })
    expect(await tell(report())).toBe(false)
    refuse = false
    clock.ms = 60_000
    expect(await tell(report())).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('never queues one behind a post that is hanging', async () => {
    // On a phone that has just lost the LAN, this post can BE the request that
    // hangs. A second race on the timer must not stack another one on it.
    const clock = { ms: 0 }
    const gate: { release: (() => void) | null } = { release: null }
    let posts = 0
    const tell = reporterOn([], clock, async () => {
      posts += 1
      await new Promise<void>((resolve) => void (gate.release = resolve))
    })
    const first = tell(report())
    clock.ms = PATH_REPORT_MIN_GAP_MS * 10
    expect(await tell(report())).toBe(false)
    expect(posts).toBe(1)
    gate.release?.()
    expect(await first).toBe(true)
  })

  it('swallows a refusal — it describes the very plane that is in trouble', async () => {
    const clock = { ms: 0 }
    const said: string[] = []
    const tell = createPathReporter({
      post: async () => {
        throw new Error('the desktop refused the path report: 503')
      },
      now: () => clock.ms,
      log: (message) => said.push(message)
    })
    expect(await tell(report())).toBe(false)
    expect(said[0]).toContain('path report not delivered')
  })
})

describe('what leaves the phone', () => {
  const capture = async (
    over: Partial<PathReport> = {},
    status = 204
  ): Promise<{ url: string; init: RequestInit }> => {
    let seen: { url: string; init: RequestInit } | null = null
    await postPathReport(report(over), {
      url: '/api/path/report',
      headers: { authorization: `Bearer ${TOKEN}` },
      fetch: async (url, init) => {
        seen = { url, init }
        return { ok: status < 400, status }
      }
    })
    return seen as unknown as { url: string; init: RequestInit }
  }

  it('is a POST of JSON to the route, with no query string on it', async () => {
    const { url, init } = await capture()
    expect(init.method).toBe('POST')
    expect(url).toBe('/api/path/report')
    // `?token=` is accepted by the Mac's gate for clients that cannot set
    // headers. This one can, so a token must never reach a URL — they end up
    // in server logs, in history and in screenshots.
    expect(url).not.toContain('?')
  })

  it('carries the credential in the header and NOWHERE in the body', async () => {
    const { init } = await capture()
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
    const body = String(init.body)
    expect(body).not.toContain(TOKEN)
    expect(body.toLowerCase()).not.toContain('token')
  })

  it('carries no URL, only the address form a reader can act on', async () => {
    const { init } = await capture()
    const body = String(init.body)
    expect(body).not.toContain('://')
    expect(body).not.toContain('d.cookrew.dev')
    expect(JSON.parse(body).attempts[0].name).toBe('192.168.1.24:8643')
  })

  it('sends exactly the five agreed fields, so the Mac can be strict', async () => {
    const { init } = await capture()
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
      'at',
      'attempts',
      'browser',
      'permission',
      'plane'
    ])
  })

  it('rejects when the desktop refuses, so the reporter can say so once', async () => {
    await expect(capture({}, 503)).rejects.toThrow('503')
  })
})
