// THE PANEL AND THE MAC BOTH HAVE TO BE ABLE TO SAY "IT WAS THE HINT".
//
// Chrome 152 behind a system proxy, 2026-09-08: `192.168.2.40:8643 refused by
// the browser before connecting — 32 ms` was the whole row, and it sent the
// reader to their site settings for a permission that was never the problem.
// The browser had refused the request because it CARRIED the local-network
// annotation, and the same request without it would have been delivered.
//
// So the row and the report carry which variant the verdict is about, and the
// two sentences that change say so — one for an answer that only got through
// unannotated, one for a refusal that happened both ways.

import { describe, expect, it } from 'vitest'
import { attemptSentence } from '../src/renderer/src/path-copy'
import { reportedAttempts } from '../src/renderer/src/path/report'
import { readPathReport } from '../src/main/path-reports'
import {
  switchPlaneIfBetter,
  type PlaneAttempt,
  type PlaneSwitchDeps
} from '../src/renderer/src/path/plane-switch'
import type { HelloResult } from '../src/renderer/src/path/hello-result'
import type { PathAttempt } from '../src/renderer/src/path-attempts'
import type { DataPlane } from '../src/renderer/src/data-plane'
import type { ReachCardLite } from '../src/renderer/src/path/switch'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`
const CGNAT = `https://100-68-81-64.${DEVICE}.d.cookrew.dev:8643`
const RELAY: DataPlane = { origin: '', kind: 'relay' }

describe('the sentence a row says', () => {
  it('is unchanged when nothing about the hint is news', () => {
    expect(attemptSentence({ outcome: 'answered', ms: 6 })).toBe('answered in 6 ms')
    expect(attemptSentence({ outcome: 'answered', ms: 6, hint: 'local' })).toBe('answered in 6 ms')
    expect(attemptSentence({ outcome: 'blocked', ms: 32 })).toBe(
      'refused by the browser before connecting — 32 ms'
    )
  })

  it('names the proxy when the answer only arrived without the annotation', () => {
    expect(attemptSentence({ outcome: 'answered', ms: 41, hint: 'none' })).toBe(
      'answered (without the local-network hint — a proxy hides the address) in 41 ms'
    )
  })

  it('says BOTH ways when the browser refused it with and without', () => {
    // The difference between "go and allow this in your site settings" and
    // "there is nothing to allow; the proxy is the reason".
    expect(attemptSentence({ outcome: 'blocked', ms: 32, hint: 'none' })).toBe(
      'refused by the browser before connecting (with and without the hint) — 32 ms'
    )
  })

  it('invents no words for the outcomes the hint cannot explain', () => {
    expect(attemptSentence({ outcome: 'timeout', ms: 800, hint: 'none' })).toBe(
      'timed out (800 ms)'
    )
    expect(attemptSentence({ outcome: 'network', ms: 240, hint: 'none' })).toBe(
      'could not connect (DNS, certificate or network) — 240 ms'
    )
  })
})

describe('the row a race writes', () => {
  const rowsFor = async (
    origin: string,
    hello: (origin: string, nonce: string) => Promise<HelloResult>
  ): Promise<readonly PlaneAttempt[]> => {
    let rows: readonly PlaneAttempt[] = []
    const deps: PlaneSwitchDeps = {
      plane: () => RELAY,
      card: async (): Promise<ReachCardLite> => ({
        deviceId: DEVICE,
        lan: [],
        tailnet: null,
        trusted: [origin]
      }),
      hello,
      verify: async () => true,
      adopt: () => undefined,
      nonce: () => 'a-nonce',
      note: (attempts) => void (rows = attempts)
    }
    await switchPlaneIfBetter(deps)
    return rows
  }

  const answered = (hint?: 'local' | 'none') =>
    async (origin: string, nonce: string): Promise<HelloResult> => ({
      ok: true,
      ...(hint ? { hint } : {}),
      reply: { v: 2, deviceId: DEVICE, nonce, sig: 's', origin, issuedAtMs: Date.now() }
    })

  it('records a LAN answer that only got through unannotated', async () => {
    const [row] = await rowsFor(LAN, answered('none'))
    expect(row).toMatchObject({ outcome: 'answered', hint: 'none' })
  })

  it('says nothing about a LAN answer that came back the ordinary way', async () => {
    const [row] = await rowsFor(LAN, answered('local'))
    expect(row.hint).toBe('local')
    expect(attemptSentence(row)).not.toContain('proxy')
  })

  it('says nothing at all about an address no browser ever annotates', async () => {
    // 100.64/10 is CGNAT and public by every reckoning, so 'none' there is not
    // a fallback — it is the only variant there ever was. A row claiming a
    // proxy would invent a fact.
    const [row] = await rowsFor(CGNAT, answered('none'))
    expect(row.hint).toBeUndefined()
    expect(attemptSentence(row)).toBe(attemptSentence({ outcome: 'answered', ms: row.ms }))
  })

  it('marks a refusal that happened with AND without the annotation', async () => {
    const [row] = await rowsFor(LAN, async () => ({
      ok: false,
      kind: 'blocked',
      ms: 32,
      attempts: [
        { hint: 'local', kind: 'blocked', ms: 32 },
        { hint: 'none', kind: 'blocked', ms: 30 }
      ]
    }))
    expect(row).toMatchObject({ outcome: 'blocked', ms: 32, hint: 'none' })
  })

  it('leaves a single-variant refusal exactly as it was', async () => {
    const [row] = await rowsFor(LAN, async () => ({
      ok: false,
      kind: 'blocked',
      ms: 32,
      attempts: [{ hint: 'local', kind: 'blocked', ms: 32 }]
    }))
    expect(row.hint).toBeUndefined()
  })
})

describe('what reaches the Mac', () => {
  const attempt = (over: Partial<PathAttempt> = {}): PathAttempt => ({
    name: '192.168.2.40:8643',
    outcome: 'blocked',
    ms: 32,
    plane: 'LAN',
    chosen: false,
    ...over
  })

  it('carries the variant on the wire, or nothing where there is nothing to say', () => {
    expect(reportedAttempts([attempt({ hint: 'none' })])[0]).toMatchObject({ hint: 'none' })
    expect(reportedAttempts([attempt()])[0]).not.toHaveProperty('hint')
  })

  it('is kept by the desktop, which used to drop every field it did not know', () => {
    const report = readPathReport(
      {
        plane: 'RELAY',
        permission: 'prompt',
        browser: 'Chrome 152',
        attempts: [{ name: '192.168.2.40:8643', outcome: 'blocked', ms: 32, hint: 'none' }]
      },
      1_800_000_000_000
    )
    expect(report?.attempts[0]).toMatchObject({ outcome: 'blocked', hint: 'none' })
  })

  it('refuses a variant that is not one of the two words', () => {
    // The route is authenticated and an authenticated caller is still a caller.
    const report = readPathReport(
      {
        plane: 'RELAY',
        permission: 'prompt',
        browser: 'Chrome 152',
        attempts: [{ name: '192.168.2.40:8643', outcome: 'blocked', ms: 32, hint: '<script>' }]
      },
      1_800_000_000_000
    )
    expect(report?.attempts[0]).not.toHaveProperty('hint')
  })
})
