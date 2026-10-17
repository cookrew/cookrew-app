// WHICH REQUESTS RIDE THE DIRECT LINK (rtc-plane.ts), AND WHEN THE PLANE
// MOVES ONTO IT AND BACK (path/rtc-adopt.ts).
import { afterEach, describe, expect, it } from 'vitest'
import { dataPlane, resetDataPlane, setDataPlane, subscribeDataPlane, fallBackToRelay } from '../src/renderer/src/data-plane'
import { linkPath, openEventSource, rtcLink, setRtcLink, viaLink } from '../src/renderer/src/rtc-plane'
import { adoptRtcLink } from '../src/renderer/src/path/rtc-adopt'
import { RtcEventSource, type RtcLink } from '../src/renderer/src/path/rtc-link'

const BASE = '/relay/@drej/desktop/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const fakeLink = (via = '192.168.2.40'): RtcLink & { readonly fireClose: () => void; closed: boolean } => {
  const closers: (() => void)[] = []
  const link = {
    via,
    closed: false,
    request: () => new Promise<Response>(() => undefined),
    openSocket: (): never => {
      throw new Error('not in this test')
    },
    isOpen: () => !link.closed,
    onClose: (cb: () => void) => {
      closers.push(cb)
      return () => undefined
    },
    close: () => {
      if (link.closed) return
      link.closed = true
      closers.forEach((cb) => cb())
    },
    fireClose: () => link.close(),
    ended: () => (link.closed ? { reason: 'closed here', afterMs: 1000 } : null),
    check: () => undefined
  }
  return link
}

afterEach(() => {
  resetDataPlane()
  setRtcLink(null)
})

describe('the Mac path for a page URL', () => {
  it('drops exactly what the registry drops, and keeps a workspace slug', () => {
    expect(linkPath(`${BASE}/api/events?boot=1`, BASE)).toBe('/api/events?boot=1')
    expect(linkPath(`${BASE}/work/api/board`, `${BASE}`)).toBe('/work/api/board')
  })

  it('is the path itself on a page served at the root', () => {
    expect(linkPath('/api/board', '')).toBe('/api/board')
  })

  it('is nothing for an absolute URL, a protocol-relative one, or a path outside the base', () => {
    expect(linkPath('https://cookrew.dev/v2/hello/verify', BASE)).toBeNull()
    expect(linkPath('//evil.example/api/x', BASE)).toBeNull()
    expect(linkPath('/v2/me', BASE)).toBeNull()
    expect(linkPath('api/x', '')).toBeNull()
  })
})

describe('routing', () => {
  it('carries nothing while the plane is not the link, however open the link is', () => {
    setRtcLink(fakeLink())
    expect(viaLink('/api/board')).toBeNull()
    setDataPlane({ origin: 'https://192.168.2.40:8643', kind: 'lan' })
    expect(viaLink('/api/board')).toBeNull()
  })

  it('carries a request and a stream when the plane is the link', () => {
    const link = fakeLink()
    setRtcLink(link)
    setDataPlane({ origin: '', kind: 'lan', transport: 'rtc' })
    expect(viaLink('/api/board')).toEqual({ link, path: '/api/board' })
    const source = openEventSource('/api/events')
    expect(source).toBeInstanceOf(RtcEventSource)
    source.close()
  })

  it('stops carrying the moment the link closes', () => {
    const link = fakeLink()
    setRtcLink(link)
    setDataPlane({ origin: '', kind: 'lan', transport: 'rtc' })
    link.close()
    expect(rtcLink()).toBeNull()
    expect(viaLink('/api/board')).toBeNull()
  })
})

describe('the plane, with the link in it', () => {
  it('keeps the relay URLs (origin empty) and is a different plane from the relay and from a direct origin', () => {
    const seen: string[] = []
    subscribeDataPlane((p) => void seen.push(`${p.kind}/${p.transport ?? '-'}/${p.origin}`))
    setDataPlane({ origin: 'ignored', kind: 'lan', transport: 'rtc' })
    setDataPlane({ origin: '', kind: 'lan', transport: 'rtc' })
    setDataPlane({ origin: 'https://192.168.2.40:8643', kind: 'lan' })
    expect(seen).toEqual(['lan/rtc/', 'lan/-/https://192.168.2.40:8643'])
  })

  it('drops the transport on the relay', () => {
    setDataPlane({ origin: '', kind: 'relay', transport: 'rtc' })
    expect(dataPlane()).toEqual({ origin: '', kind: 'relay' })
  })
})

describe('adopting the link', () => {
  const deps = (link: RtcLink | null) => ({
    connect: async () => link,
    plane: dataPlane,
    adopt: setDataPlane,
    fallBack: fallBackToRelay,
    setLink: setRtcLink,
    classify: (a: string): 'lan' | 'tailnet' | 'other' =>
      a.startsWith('192.168.') ? 'lan' : a.startsWith('100.') ? 'tailnet' : 'other',
    now: () => 0
  })

  it('moves the plane to LAN by the address the Mac named', async () => {
    const row = await adoptRtcLink(deps(fakeLink('192.168.2.40')))
    expect(dataPlane()).toEqual({ origin: '', kind: 'lan', transport: 'rtc' })
    expect(row).toEqual({ kind: 'rtc', name: '192.168.2.40', outcome: 'answered', ms: 0 })
  })

  it('moves it to TAILNET when that is the address', async () => {
    await adoptRtcLink(deps(fakeLink('100.68.81.64')))
    expect(dataPlane().kind).toBe('tailnet')
  })

  it('falls back to the relay when the link closes', async () => {
    const link = fakeLink()
    await adoptRtcLink(deps(link))
    link.fireClose()
    expect(dataPlane()).toEqual({ origin: '', kind: 'relay' })
    expect(rtcLink()).toBeNull()
  })

  it('leaves a plane that moved on alone when the old link closes', async () => {
    const link = fakeLink()
    await adoptRtcLink(deps(link))
    setDataPlane({ origin: 'https://192.168.2.40:8643', kind: 'lan' })
    link.fireClose()
    expect(dataPlane().origin).toBe('https://192.168.2.40:8643')
  })

  it('adopts nothing on an address it cannot name, and lets the link go', async () => {
    const link = fakeLink('198.18.0.1')
    await adoptRtcLink(deps(link))
    expect(dataPlane().kind).toBe('relay')
    expect(link.closed).toBe(true)
  })

  it('adopts nothing when another plane won while the link was opening', async () => {
    const link = fakeLink()
    const d = deps(link)
    await adoptRtcLink({
      ...d,
      connect: async () => {
        setDataPlane({ origin: 'https://192.168.2.40:8643', kind: 'lan' })
        return link
      }
    })
    expect(dataPlane().transport).toBeUndefined()
    expect(link.closed).toBe(true)
  })

  it('reports a timeout and stays on the relay when no link opens', async () => {
    const row = await adoptRtcLink(deps(null))
    expect(row.outcome).toBe('timeout')
    expect(dataPlane().kind).toBe('relay')
  })
})
