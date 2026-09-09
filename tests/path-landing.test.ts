import { describe, expect, it } from 'vitest'
import {
  LANDED,
  arrivedFromRelay,
  landedAddress,
  landingDetail,
  landingReport,
  type LandingTiming
} from '../src/renderer/src/path/landing'

/**
 * THE PAGE THAT ARRIVED SAYS WHERE THE SECONDS WENT.
 *
 * On 2026-09-09 the OPEN ON WI-FI button left the owner's iPhone blank for
 * about twenty seconds before the canvas came up, and nothing on the Mac could
 * say whether that was the name lookup, the certificate or the Mac itself.
 * The landed page has the browser's own timeline for the trip, and posts it
 * as one `landed` row the reports endpoint already knows how to keep.
 */

const TOKEN = 'cr_token_should_never_appear'
const NAME = '192-168-2-40.e03994f9-138d-80ff-9377-475cc59142b4.d.cookrew.dev'

const slowLookup: LandingTiming = {
  name: `https://${NAME}:8643/?token=${TOKEN}&from=relay`,
  startTime: 0,
  domainLookupStart: 12,
  domainLookupEnd: 15032,
  connectStart: 15032,
  secureConnectionStart: 15044,
  connectEnd: 15420,
  requestStart: 15421,
  responseStart: 15461
}

describe('arrivedFromRelay', () => {
  it('is true only for the button’s own query', () => {
    expect(arrivedFromRelay(slowLookup.name)).toBe(true)
    expect(arrivedFromRelay(`https://${NAME}:8643/`)).toBe(false)
    expect(arrivedFromRelay(`https://${NAME}:8643/?from=bookmark`)).toBe(false)
    expect(arrivedFromRelay('not a url')).toBe(false)
  })
})

describe('landedAddress', () => {
  it('turns the trusted name back into the address the panel spells', () => {
    expect(landedAddress(`${NAME}:8643`)).toBe('192.168.2.40:8643')
  })

  it('keeps a bare address as it is', () => {
    expect(landedAddress('192.168.2.40:8643')).toBe('192.168.2.40:8643')
    expect(landedAddress('100.68.81.64')).toBe('100.68.81.64')
  })

  it('refuses a host that is neither', () => {
    expect(landedAddress('cookrew.dev')).toBeNull()
    expect(landedAddress('localhost:8643')).toBeNull()
  })
})

describe('landingDetail', () => {
  it('splits the trip into the phases a reader diagnoses', () => {
    expect(landingDetail(slowLookup)).toBe('dns 15020 ms · connect 388 ms · tls 376 ms · wait 40 ms')
  })

  it('leaves out a phase the browser did not measure', () => {
    const reused: LandingTiming = {
      ...slowLookup,
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      secureConnectionStart: 0,
      connectEnd: 0,
      requestStart: 20,
      responseStart: 60
    }
    expect(landingDetail(reused)).toBe('wait 40 ms')
  })

  it('reports an instant phase as zero rather than dropping it', () => {
    expect(landingDetail({ ...slowLookup, domainLookupEnd: 12 })).toContain('dns 0 ms')
  })
})

describe('landingReport', () => {
  const facts = {
    timing: slowLookup,
    host: `${NAME}:8643`,
    plane: 'LAN' as const,
    browser: 'Chrome 152',
    permission: 'unsupported',
    now: 1_700_000_000_000
  }

  it('is one landed row with the whole trip and its split', () => {
    expect(landingReport(facts)).toEqual({
      at: 1_700_000_000_000,
      plane: 'LAN',
      permission: 'unsupported',
      browser: 'Chrome 152',
      attempts: [
        {
          name: '192.168.2.40:8643',
          outcome: LANDED,
          ms: 15461,
          detail: 'dns 15020 ms · connect 388 ms · tls 376 ms · wait 40 ms'
        }
      ]
    })
  })

  it('never repeats the credential it read the query from', () => {
    expect(JSON.stringify(landingReport(facts))).not.toContain(TOKEN)
  })

  it('says nothing for a page that was typed, bookmarked or reloaded', () => {
    expect(
      landingReport({ ...facts, timing: { ...slowLookup, name: `https://${NAME}:8643/` } })
    ).toBeNull()
  })

  it('says nothing without a navigation entry or off an unknown host', () => {
    expect(landingReport({ ...facts, timing: null })).toBeNull()
    expect(landingReport({ ...facts, host: 'cookrew.dev' })).toBeNull()
  })
})
