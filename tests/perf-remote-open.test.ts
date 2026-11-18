import { describe, expect, it } from 'vitest'
import { FIRST_CARD_SELECTOR, bootCharged, requestKind, summarise, type RecordedRequest } from '../scripts/perf-remote-open.mjs'

/**
 * The remote-open recorder (scripts/perf-remote-open.mjs) feeds the nightly
 * perf eval, and its request rule feeds the CI gate (tests/perf/
 * remote-open.perf.ts). Plain JS, so these pin what a typo would break
 * quietly: what counts as a boot request, and that a boot with no first card
 * is reported as unmeasured rather than as everything the settle saw.
 */

describe('what a boot request is', () => {
  it('streams are the held-open EventSources, by path, on the LAN and through the relay', () => {
    expect(requestKind('/api/events?boot=abc&token=t')).toBe('stream')
    expect(requestKind('/api/fleet/stream?token=t')).toBe('stream')
    expect(requestKind('/api/terminal/t1/stream')).toBe('stream')
    expect(requestKind('https://cookrew.dev/relay/@me/desktop/d1/api/fleet/stream')).toBe('stream')
    // Reads that share a prefix with a stream are requests, not streams.
    expect(requestKind('/api/events/query?type=note.created')).toBe('request')
    expect(requestKind('/api/terminal/t1/stream/open')).toBe('request')
  })

  it('thumbnails and the beacon are told apart from the requests the boot is charged with', () => {
    expect(requestKind('/api/browser/thumbs?ids=a,b')).toBe('thumb')
    expect(requestKind('/api/browser/b1/thumb')).toBe('thumb')
    expect(requestKind('/api/beacon')).toBe('beacon')
    expect(requestKind('/api/workspace')).toBe('request')
    expect(requestKind('/assets/App-x.js')).toBe('request')
  })

  it('charges the first beacon and none after it, and no stream or thumb', () => {
    const rows = ['/api/beacon', '/api/workspace', '/api/events?boot=x', '/api/beacon', '/api/browser/thumbs', '/api/beacon']
    expect(bootCharged(rows, (p) => p)).toEqual(['/api/beacon', '/api/workspace'])
  })

  it('looks for the zoom view’s agent, not the retired canvas card', () => {
    expect(FIRST_CARD_SELECTOR).toBe('.zv-card')
  })
})

describe('the summary', () => {
  const at = (url: string, start: number): RecordedRequest => ({ url: `http://c.local${url}`, type: 'Fetch', start, end: start + 0.01, bytes: 100, status: 200 })
  const requests = [at('/', 0), at('/api/workspace', 0.1), at('/api/beacon', 0.1), at('/api/events?boot=x', 0.1), at('/api/beacon', 3.1), at('/api/late', 9)]

  it('counts the window from first card to two seconds after it', () => {
    const s = summarise({ requests, navStart: 0, marks: { firstCard: 500 }, settleS: 12 })
    expect(s.boot.measured).toBe(true)
    // The document, the workspace, the first beacon: not the stream, the second beacon or the late read.
    expect(s.boot.requests).toBe(3)
    expect(s.firstCardMs).toBe(500)
  })

  it('a boot that drew no card is NOT MEASURED, never charged with the whole settle', () => {
    const s = summarise({ requests, navStart: 0, marks: { firstCard: null }, settleS: 12 })
    expect(s.boot.measured).toBe(false)
    expect(s.boot.requests).toBeNull()
    expect(s.interactiveMs).toBeNull()
  })
})
