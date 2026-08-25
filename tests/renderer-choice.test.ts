import { describe, expect, it } from 'vitest'
import { rendererSourceFor, staleBuildNotice } from '../src/main/renderer-choice'

/**
 * The bug: in dev the companion proxies Vite's UNBUNDLED module graph —
 * measured on this app at 159 requests, 4.57 MB, six levels of import
 * waterfall. On the LAN that costs 0.3 s. Over a tailnet with no direct path
 * (DERP relay, 293 ms to 2.5 s round trip, 2 of 5 probes lost) those 159
 * dependent requests never finish, and the phone shows a blank page with a
 * stalled progress bar. Same server, same cert — only the link differs, which
 * is exactly the shape of "Wi-Fi ok, cellular not".
 */

const BOTH = { devAvailable: true, builtAvailable: true }

describe('rendererSourceFor', () => {
  it('sends a tailnet peer to the built bundle', () => {
    expect(rendererSourceFor({ ...BOTH, remoteAddress: '100.78.119.86' })).toBe('built')
  })

  it('sees through an IPv4-mapped peer on the dual-stack listener', () => {
    // The listener binds `::`, so every IPv4 phone arrives as ::ffff:… — the
    // check has to survive that or it silently never fires in production.
    expect(rendererSourceFor({ ...BOTH, remoteAddress: '::ffff:100.78.119.86' })).toBe('built')
  })

  it('recognises a tailnet IPv6 peer', () => {
    expect(rendererSourceFor({ ...BOTH, remoteAddress: 'fd7a:115c:a1e0::1234' })).toBe('built')
  })

  it('leaves the LAN and loopback on the live module graph', () => {
    // This is where the edit-reload loop happens and where the link can pay
    // for it. Diverting these would cost live code for no benefit.
    expect(rendererSourceFor({ ...BOTH, remoteAddress: '192.168.2.13' })).toBe('dev')
    expect(rendererSourceFor({ ...BOTH, remoteAddress: '::ffff:127.0.0.1' })).toBe('dev')
    expect(rendererSourceFor({ ...BOTH, remoteAddress: '10.0.0.4' })).toBe('dev')
  })

  it('does not mistake ordinary 100.x space for the tailnet', () => {
    // 100.64.0.0/10 is the tailnet; 100.12.x is public internet space.
    expect(rendererSourceFor({ ...BOTH, remoteAddress: '100.12.0.1' })).toBe('dev')
  })

  it('falls back rather than serving nothing when one source is absent', () => {
    // A packaged app has no dev server; a fresh checkout has no build. Neither
    // may end in a diversion to something that does not exist.
    expect(
      rendererSourceFor({ devAvailable: false, builtAvailable: true, remoteAddress: '192.168.2.13' })
    ).toBe('built')
    expect(
      rendererSourceFor({ devAvailable: true, builtAvailable: false, remoteAddress: '100.78.119.86' })
    ).toBe('dev')
  })

  it('keeps today’s behaviour for a peer with no address', () => {
    expect(rendererSourceFor({ ...BOTH, remoteAddress: undefined })).toBe('dev')
  })
})

describe('staleBuildNotice', () => {
  const built = new Date('2026-08-11T01:41:00Z')

  it('names the gap when the bundle is behind the source', () => {
    // The person looking at a week-old UI is holding a phone, so the notice
    // has to reach the phone; saying it on the desktop helps nobody.
    const notice = staleBuildNotice(built, new Date('2026-08-18T09:00:00Z'))
    expect(notice).toContain('7 days behind')
    expect(notice).toContain('npm run build')
  })

  it('says nothing when the build is current', () => {
    expect(staleBuildNotice(built, new Date('2026-08-10T00:00:00Z'))).toBeNull()
    expect(staleBuildNotice(built, built)).toBeNull()
  })

  it('drops the day count when the gap is under a day', () => {
    const notice = staleBuildNotice(built, new Date('2026-08-11T06:00:00Z'))
    expect(notice).toContain('behind')
    expect(notice).not.toContain('0 days')
  })

  it('says nothing when either side is unknown', () => {
    expect(staleBuildNotice(null, new Date())).toBeNull()
    expect(staleBuildNotice(built, null)).toBeNull()
  })
})
