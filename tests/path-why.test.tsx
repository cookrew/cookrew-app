// WHY THIS PATH — the panel that is the difference between a product and a
// support thread.
//
// Every product in the survey that shows a path word and nothing else has a
// forum full of "why does it say Indirect?", because the word is a conclusion
// with no evidence attached. Home Assistant's "Connected via" is the clearest
// case: users report it as unreliable, and what they mean is that they cannot
// check it.
//
// So the race writes down what it tried and the panel reads it back: the
// address form of each name, what happened to it, and how long it took. Two
// rules it must never break — no token and no device id ever appear in a row
// (the name is the ADDRESS the label spells, not the label), and a candidate
// that was blocked by the browser is not spelled the same as a candidate that
// did not answer, because those two send a reader to opposite places.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PathAttempt } from '../src/renderer/src/path-attempts'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const panel = async (
  attempts: readonly PathAttempt[],
  settled: 'LAN' | 'TAILNET' | 'RELAY' = 'RELAY'
): Promise<string> => {
  vi.resetModules()
  const store = await import('../src/renderer/src/path-attempts')
  const { PathWhy } = await import('../src/renderer/src/PathWhy')
  store.resetPathAttempts()
  store.recordAttempts(attempts, settled)
  return renderToStaticMarkup(<PathWhy />)
}

const attempt = (over: Partial<PathAttempt> = {}): PathAttempt => ({
  name: '192.168.1.24:8643',
  outcome: 'answered',
  ms: 6,
  plane: 'LAN',
  chosen: true,
  ...over
})

afterEach(() => vi.resetModules())

describe('the panel', () => {
  it('is closed until it is asked for', async () => {
    const markup = await panel([attempt()], 'LAN')
    // <details> without `open`: the evidence is there for anybody who wants
    // it and costs no room for everybody who does not.
    expect(markup).toContain('<details')
    expect(markup).not.toContain('open=""')
    expect(markup).toContain('Why this path')
  })

  it('is not there at all before a race has happened', async () => {
    expect(await panel([])).toBe('')
  })

  it('names the address, never the label and never a token', async () => {
    const markup = await panel([attempt()], 'LAN')
    expect(markup).toContain('192.168.1.24:8643')
    // The trusted name carries the device id in a label; a row that quoted the
    // hostname would put a permanent device identifier on screen.
    expect(markup).not.toContain(DEVICE)
    expect(markup).not.toContain('d.cookrew.dev')
    expect(markup).not.toContain('token')
  })
})

describe('one row for each way a candidate can end', () => {
  it('says how long an answer took, and which plane it became', async () => {
    const markup = await panel([attempt({ ms: 6 })], 'LAN')
    expect(markup).toContain('answered in 6 ms')
    expect(markup).toContain('LAN')
  })

  it('says no answer, without a time it does not have', async () => {
    const markup = await panel([attempt({ outcome: 'no-answer', ms: null, chosen: false })])
    expect(markup).toContain('no answer')
    expect(markup).not.toContain('ms')
  })

  it('says refused by the browser, which is not the same as no answer', async () => {
    // A refusal sends the reader to their site settings; silence sends them to
    // the Mac. Spelling them the same is what fills a forum.
    const markup = await panel([attempt({ outcome: 'refused', ms: null, chosen: false })])
    expect(markup).toContain('refused by the browser')
    expect(markup).not.toContain('no answer')
  })

  it('says not verified when the registry would not vouch for an answer', async () => {
    const markup = await panel([attempt({ outcome: 'unverified', ms: 9, chosen: false })])
    expect(markup).toContain('not verified')
    // The time is still shown: it answered, quickly, and was still refused —
    // which is precisely the shape of somebody else's machine on this Wi-Fi.
    expect(markup).toContain('9 ms')
  })

  it('lists every candidate, in the order they were raced', async () => {
    const markup = await panel(
      [
        attempt({ name: '192.168.1.24:8643', outcome: 'no-answer', ms: null, chosen: false }),
        attempt({ name: '10.0.0.9:8643', outcome: 'answered', ms: 6, plane: 'LAN' }),
        attempt({ name: '100.68.81.64:8643', outcome: 'no-answer', ms: null, plane: 'TAILNET', chosen: false })
      ],
      'LAN'
    )
    expect(markup.indexOf('192.168.1.24')).toBeLessThan(markup.indexOf('10.0.0.9'))
    expect(markup.indexOf('10.0.0.9')).toBeLessThan(markup.indexOf('100.68.81.64'))
  })

  it('marks the one that won, so the panel answers its own question', async () => {
    const markup = await panel(
      [
        attempt({ name: '192.168.1.24:8643', outcome: 'unverified', ms: 4, chosen: false }),
        attempt({ name: '10.0.0.9:8643', outcome: 'answered', ms: 22 })
      ],
      'LAN'
    )
    expect(markup).toContain('cr-path-why-chosen')
  })
})

describe('the store', () => {
  it('replaces the last race rather than growing for ever', async () => {
    vi.resetModules()
    const store = await import('../src/renderer/src/path-attempts')
    store.resetPathAttempts()
    store.recordAttempts([attempt(), attempt()], 'LAN')
    store.recordAttempts([attempt()], 'RELAY')
    expect(store.pathAttempts().attempts).toHaveLength(1)
    expect(store.pathAttempts().settled).toBe('RELAY')
  })

  it('tells its listeners, because the badge sheet is open while a race runs', async () => {
    vi.resetModules()
    const store = await import('../src/renderer/src/path-attempts')
    store.resetPathAttempts()
    let told = 0
    const off = store.subscribePathAttempts(() => void (told += 1))
    store.recordAttempts([attempt()], 'LAN')
    expect(told).toBe(1)
    off()
    store.recordAttempts([], 'RELAY')
    expect(told).toBe(1)
  })
})
