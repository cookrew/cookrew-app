// THE PANEL SAYS WHICH FAILURE IT WAS, AND UNDER WHAT CONDITIONS.
//
// The screenshot that caused this: four LAN candidates, four rows reading "no
// answer", a 13,328 ms relay round trip, and no way to tell whether the phone
// had refused the requests itself or the Mac was asleep. Every sentence below
// exists to send a reader somewhere different — site settings, the Wi-Fi, the
// Mac, or whatever else is answering on that port — and the header line is the
// condition all of them ran under, because "refused before connecting" means
// one thing in a denied Chrome and another in a Safari with no such permission.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { browserFamily } from '../src/renderer/src/browser-family'
import { attemptSentence } from '../src/renderer/src/path-copy'
import type { PathAttempt } from '../src/renderer/src/path-attempts'
import type { LocalNetworkState } from '../src/renderer/src/local-network'

const CHROME =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'
const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const attempt = (over: Partial<PathAttempt> = {}): PathAttempt => ({
  name: '192.168.1.24:8643',
  outcome: 'answered',
  ms: 6,
  plane: 'LAN',
  chosen: false,
  ...over
})

const panel = async (
  attempts: readonly PathAttempt[],
  environment: { readonly ua?: string; readonly permission?: LocalNetworkState } = {}
): Promise<string> => {
  vi.resetModules()
  vi.stubGlobal('navigator', { userAgent: environment.ua ?? CHROME })
  const store = await import('../src/renderer/src/path-attempts')
  const gate = await import('../src/renderer/src/local-network-gate')
  const { PathWhy } = await import('../src/renderer/src/PathWhy')
  store.resetPathAttempts()
  gate.resetLocalNetworkGate()
  if (environment.permission) gate.setLocalNetwork(environment.permission)
  store.recordAttempts(attempts, 'RELAY')
  return renderToStaticMarkup(<PathWhy />)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the sentence for each new kind', () => {
  it('says a timeout timed out, and quotes the deadline that fired', async () => {
    // Something held a socket for the whole 800 ms. That is a slow network,
    // not a blocked one, and the number is the evidence.
    const markup = await panel([attempt({ outcome: 'timeout', ms: 800 })])
    expect(markup).toContain('timed out (800 ms)')
  })

  it('says a blocked probe was refused by the browser BEFORE connecting', async () => {
    // The fix is three taps into site settings; nothing is wrong with the Mac.
    const markup = await panel([attempt({ outcome: 'blocked', ms: 1 })])
    expect(markup).toContain('refused by the browser before connecting')
  })

  it('says a network failure could not connect, and names the three causes', async () => {
    const markup = await panel([attempt({ outcome: 'network', ms: 240 })])
    expect(markup).toContain('could not connect (DNS, certificate or network)')
  })

  it('quotes the status when something actually answered', async () => {
    // 421 is the endpoint-bound hello refusing a relayed challenge; a 404 is
    // somebody else's server on port 8643. Both are answers.
    const markup = await panel([attempt({ outcome: 'http', status: 421, ms: 12 })])
    expect(markup).toContain('answered 421')
  })

  it('still says the four old ones exactly as it did', async () => {
    expect(attemptSentence({ outcome: 'answered', ms: 6 })).toBe('answered in 6 ms')
    expect(attemptSentence({ outcome: 'no-answer', ms: null })).toBe('no answer')
    expect(attemptSentence({ outcome: 'refused', ms: null })).toBe('refused by the browser')
    expect(attemptSentence({ outcome: 'unverified', ms: 9 })).toBe('not verified — 9 ms')
  })

  it("shows the browser's own words when there are any, and no address", async () => {
    const markup = await panel([
      attempt({ outcome: 'blocked', ms: 1, detail: 'TypeError: Failed to fetch' })
    ])
    expect(markup).toContain('TypeError: Failed to fetch')
    expect(markup).not.toContain('d.cookrew.dev')
  })
})

describe('the header line', () => {
  it('names the browser family and the permission, once, above the rows', async () => {
    const markup = await panel([attempt({ outcome: 'blocked', ms: 1 })], {
      ua: CHROME,
      permission: 'denied'
    })
    expect(markup).toContain('Chrome 142 · local network refused')
    expect(markup.indexOf('Chrome 142')).toBeLessThan(markup.indexOf('192.168.1.24'))
    // Once. A per-row copy would be four identical lines on a phone screen.
    expect(markup.split('Chrome 142')).toHaveLength(2)
  })

  it('says a Safari has no such permission, rather than implying a refusal', async () => {
    const markup = await panel([attempt({ outcome: 'blocked', ms: 1 })], {
      ua: SAFARI,
      permission: 'unsupported'
    })
    expect(markup).toContain('Safari 17 · local network permission not supported')
  })

  it('is never the whole user-agent string, which is a fingerprint', async () => {
    const markup = await panel([attempt()], { ua: SAFARI, permission: 'granted' })
    expect(markup).not.toContain('AppleWebKit')
    expect(markup).not.toContain('15E148')
    expect(markup).toContain('local network allowed')
  })

  it('is absent with the panel, before any race has happened', async () => {
    expect(await panel([])).toBe('')
  })
})

describe('the browser family', () => {
  it('reads Chrome first, because every Chrome claims to be Safari', () => {
    expect(browserFamily(CHROME)).toBe('Chrome 142')
    expect(browserFamily(SAFARI)).toBe('Safari 17')
  })

  it('calls Chrome on iOS Chrome — it is the browser whose settings they open', () => {
    expect(
      browserFamily('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/141.0.0.0 Mobile Safari/604.1')
    ).toBe('Chrome 141')
  })

  it('answers other rather than guessing, and never throws', () => {
    expect(browserFamily('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/130.0')).toBe('other')
    expect(browserFamily(undefined)).toBe('other')
    expect(browserFamily('')).toBe('other')
  })
})
