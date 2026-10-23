// A LINK THAT STAYS UP (path/rtc-link.ts, round P3): it rides out a blip,
// notices a Mac that went quiet, checks itself when the page comes back, and
// moves the plane before it fails the requests that were riding it.
import { afterEach, describe, expect, it } from 'vitest'
import { connectRtcLink, type RtcLink, type RtcLinkDeps } from '../src/renderer/src/path/rtc-link'
import { adoptRtcLink, type RtcRow } from '../src/renderer/src/path/rtc-adopt'
import { dataPlane, fallBackToRelay, resetDataPlane, setDataPlane } from '../src/renderer/src/data-plane'
import { decodeFrame, encodeFrame, type RelayFrame } from '../src/shared/relay-frame'

/** A Mac that answers pings when `pongs` is on, and nothing else. */
class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'
  pongs = true
  /** What this phone has queued and not yet sent: an upload going up. */
  bufferedAmount = 0
  readonly sent: RelayFrame[] = []
  send(data: string): void {
    const frame = decodeFrame(data)
    if (!frame) throw new Error('not a frame')
    this.sent.push(frame)
    if (frame.t === 'ping' && this.pongs) this.deliver({ t: 'pong', at: frame.at })
  }
  deliver(frame: RelayFrame): void {
    this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(frame) }))
  }
  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
}

interface Rig {
  readonly link: RtcLink
  readonly channel: FakeChannel
  readonly state: (next: RTCPeerConnectionState) => void
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const open = async (over: Partial<RtcLinkDeps> = {}): Promise<Rig> => {
  let channel!: FakeChannel
  const pc = new EventTarget() as EventTarget & Record<string, unknown>
  Object.assign(pc, {
    iceGatheringState: 'complete',
    connectionState: 'connected',
    localDescription: { sdp: 'v=0' },
    createDataChannel: () => (channel = new FakeChannel()),
    createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async () => {
      queueMicrotask(() => {
        channel.readyState = 'open'
        channel.dispatchEvent(new Event('open'))
        channel.deliver({ t: 'ready', name: '192.168.2.40' })
      })
    },
    close: () => channel.close()
  })
  const link = await connectRtcLink({
    offer: async () => 'v=0',
    peer: () => pc as unknown as RTCPeerConnection,
    gatherMs: 5,
    openMs: 50,
    ...over
  })
  if (!link) throw new Error('no link')
  return {
    link,
    channel,
    state: (next) => {
      pc.connectionState = next
      pc.dispatchEvent(new Event('connectionstatechange'))
    }
  }
}

const links: RtcLink[] = []
const tracked = async (over: Partial<RtcLinkDeps> = {}): Promise<Rig> => {
  const rig = await open(over)
  links.push(rig.link)
  return rig
}
afterEach(() => {
  for (const link of links.splice(0)) link.close()
  resetDataPlane()
})

describe('a blip', () => {
  it('is ridden out: disconnected and back within the grace keeps the link', async () => {
    const { link, state } = await tracked({ graceMs: 40 })
    state('disconnected')
    await wait(10)
    state('connected')
    await wait(60)
    expect(link.isOpen()).toBe(true)
  })

  it('that does not heal ends the link, and says why', async () => {
    const { link, state } = await tracked({ graceMs: 20 })
    state('disconnected')
    await wait(50)
    expect(link.isOpen()).toBe(false)
    expect(link.ended()?.reason).toBe('disconnected')
  })

  it('a failure ends it at once', async () => {
    const { link, state } = await tracked({ graceMs: 10_000 })
    state('failed')
    expect(link.ended()?.reason).toBe('failed')
  })
})

describe('the heartbeat', () => {
  it('pings, and a Mac that answers keeps the link', async () => {
    const { link, channel } = await tracked({ pingMs: 10, deadMs: 35 })
    await wait(80)
    expect(channel.sent.filter((f) => f.t === 'ping').length).toBeGreaterThan(3)
    expect(link.isOpen()).toBe(true)
  })

  it('ends a link whose Mac went quiet', async () => {
    const { link, channel } = await tracked({ pingMs: 10, deadMs: 35 })
    channel.pongs = false
    await wait(90)
    expect(link.ended()?.reason).toBe('silent')
  })

  it('does not blame the Mac for a page the phone suspended', async () => {
    // Timers stop with the screen off; the first tick after is a long gap.
    let clock = 0
    const { link, channel } = await tracked({ pingMs: 10, deadMs: 35, now: () => clock })
    channel.pongs = false
    clock = 10_000
    await wait(15)
    expect(link.isOpen()).toBe(true)
  })
})

describe('coming back to the front', () => {
  it('keeps a link the Mac still answers', async () => {
    const { link } = await tracked({ checkMs: 20 })
    link.check()
    await wait(40)
    expect(link.isOpen()).toBe(true)
  })

  it('ends a link that died while the phone slept, in seconds rather than at the heartbeat', async () => {
    const { link, channel } = await tracked({ checkMs: 20 })
    channel.pongs = false
    link.check()
    await wait(40)
    expect(link.ended()?.reason).toBe('silent after the page came back')
  })
})

describe('asking the Mac whether it is there (plane-health.ts asks before giving a plane up)', () => {
  it('answers true when the Mac pongs, and keeps the link', async () => {
    const { link } = await tracked({ checkMs: 20 })
    expect(await link.probe('a stream went silent')).toBe(true)
    expect(link.isOpen()).toBe(true)
  })

  it('answers false and closes with the reason when nothing comes back', async () => {
    const { link, channel } = await tracked({ checkMs: 20 })
    channel.pongs = false
    expect(await link.probe('a stream went silent')).toBe(false)
    expect(link.ended()?.reason).toBe('a stream went silent')
  })

  it('is one question at a time', async () => {
    const { link, channel } = await tracked({ checkMs: 20 })
    channel.pongs = false
    const pings = (): number => channel.sent.filter((frame) => frame.t === 'ping').length
    const before = pings()
    const first = link.probe('one')
    const second = link.probe('two')
    expect(await Promise.all([first, second])).toEqual([false, false])
    expect(pings() - before).toBe(1)
    expect(link.ended()?.reason).toBe('one')
  })

  it('does not call an upload still leaving the phone silence', async () => {
    const { link, channel } = await tracked({ checkMs: 20 })
    channel.pongs = false
    channel.bufferedAmount = 64 * 1024
    const answer = link.probe('a stream went silent')
    await wait(50)
    expect(link.isOpen()).toBe(true)
    channel.deliver({ t: 'pong', at: Date.now() })
    expect(await answer).toBe(true)
  })

  it('asks on its own when a request has had no head for a while', async () => {
    const { link, channel } = await tracked({ checkMs: 20 })
    const pings = (): number => channel.sent.filter((frame) => frame.t === 'ping').length
    const before = pings()
    void link.request({ method: 'GET', path: '/api/slow', headers: {} }).catch(() => undefined)
    await wait(2_600)
    expect(pings()).toBeGreaterThan(before)
    expect(link.isOpen()).toBe(true)
  })

  it('reports the pong round trips it saw when it ends', async () => {
    const { link } = await tracked({ checkMs: 20 })
    await link.probe('warm')
    link.close('the plane moved')
    expect(link.ended()?.reason).toBe('the plane moved')
    expect(link.ended()?.rtt).not.toBeNull()
  })
})

describe('closing', () => {
  it('moves the plane before it fails the requests in flight, so a blip earns no hold', async () => {
    const { link, state } = await tracked()
    const order: string[] = []
    link.onClose(() => void order.push('fell back'))
    const pending = link.request({ method: 'GET', path: '/api/x', headers: {} }).catch(() => void order.push('request failed'))
    state('failed')
    await pending
    expect(order).toEqual(['fell back', 'request failed'])
  })

  it('reports how an adopted link ended, for the next path report', async () => {
    const { link, state } = await tracked()
    const rows: RtcRow[] = []
    await adoptRtcLink({
      connect: async () => link,
      plane: dataPlane,
      adopt: setDataPlane,
      fallBack: fallBackToRelay,
      setLink: () => undefined,
      classify: () => 'lan',
      ended: (row) => void rows.push(row)
    })
    expect(dataPlane().kind).toBe('lan')
    state('failed')
    expect(dataPlane().kind).toBe('relay')
    expect(rows).toEqual([{ kind: 'rtc', name: '192.168.2.40 closed: failed', outcome: 'closed', ms: expect.any(Number) }])
  })
})
