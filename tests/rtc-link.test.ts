// THE PHONE'S END OF THE DIRECT LINK (path/rtc-link.ts): a fetch-shaped
// request and an EventSource-shaped stream over the relay's own frames, on a
// data channel. The peer is stood in for — what is tested is every way the
// frames could be read wrong without anything raising an error.
import { describe, expect, it } from 'vitest'
import {
  connectRtcLink,
  RTC_BODY_CHUNK,
  RtcEventSource,
  type RtcLink
} from '../src/renderer/src/path/rtc-link'
import { decodeFrame, encodeFrame, type RelayFrame } from '../src/shared/relay-frame'

type Answer = (frame: RelayFrame, reply: (frame: RelayFrame) => void) => void

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'
  readonly sent: RelayFrame[] = []
  constructor(private readonly mac: Answer) {
    super()
  }
  send(data: string): void {
    const frame = decodeFrame(data)
    if (!frame) throw new Error('not a frame')
    this.sent.push(frame)
    this.mac(frame, (back) => this.deliver(back))
  }
  deliver(frame: RelayFrame): void {
    this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(frame) }))
  }
  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }
  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
}

interface Rig {
  readonly channel: () => FakeChannel
  readonly peer: () => RTCPeerConnection
}

/** A peer whose channel opens and hears `ready` as soon as the answer goes in. */
const rig = (mac: Answer, via: string | null = '192.168.2.40'): Rig => {
  let channel: FakeChannel | null = null
  const peer = (): RTCPeerConnection => {
    const pc = new EventTarget() as EventTarget & Record<string, unknown>
    Object.assign(pc, {
      iceGatheringState: 'complete',
      connectionState: 'new',
      localDescription: { sdp: 'v=0 offer' },
      createDataChannel: () => (channel = new FakeChannel(mac)),
      createOffer: async () => ({ type: 'offer', sdp: 'v=0 offer' }),
      setLocalDescription: async () => undefined,
      setRemoteDescription: async () => {
        queueMicrotask(() => {
          channel!.open()
          if (via !== null) channel!.deliver({ t: 'ready', name: via })
        })
      },
      close: () => channel?.close()
    })
    return pc as unknown as RTCPeerConnection
  }
  return { channel: () => channel!, peer }
}

/** A Mac that answers every request with the given status and body pieces. */
const answering =
  (status: number, pieces: readonly string[], headers: Record<string, string> = {}): Answer =>
  (frame, reply) => {
    if (frame.t !== 'body' || frame.done !== true) return
    reply({ t: 'head', id: frame.id, status, headers: { 'content-type': 'text/plain', ...headers } })
    for (const piece of pieces) reply({ t: 'chunk', id: frame.id, data: Buffer.from(piece).toString('base64') })
    reply({ t: 'end', id: frame.id })
  }

const open = async (mac: Answer, via?: string | null): Promise<{ link: RtcLink; rig: Rig }> => {
  const r = rig(mac, via)
  const link = await connectRtcLink({ offer: async () => 'v=0 answer', peer: r.peer, gatherMs: 5, openMs: 50 })
  if (!link) throw new Error('no link')
  return { link, rig: r }
}

describe('connecting', () => {
  it('is the address the Mac named, once it named one', async () => {
    const { link } = await open(answering(200, []))
    expect(link.via).toBe('192.168.2.40')
    expect(link.isOpen()).toBe(true)
  })

  it('is nothing when the Mac offers no link', async () => {
    const r = rig(answering(200, []))
    expect(await connectRtcLink({ offer: async () => null, peer: r.peer, gatherMs: 5 })).toBeNull()
  })

  it('is nothing when the channel opens and the Mac never says where it is', async () => {
    const r = rig(answering(200, []), null)
    expect(await connectRtcLink({ offer: async () => 'v=0', peer: r.peer, gatherMs: 5, openMs: 30 })).toBeNull()
  })

  it('is nothing when the offer cannot even be sent', async () => {
    const r = rig(answering(200, []))
    expect(
      await connectRtcLink({ offer: () => Promise.reject(new Error('relay down')), peer: r.peer, gatherMs: 5 })
    ).toBeNull()
  })
})

describe('a request', () => {
  it('reads as a Response, its body put back together from the chunks', async () => {
    const { link } = await open(answering(200, ['{"a":', '1}'], { 'content-encoding': 'gzip', 'x-kept': 'yes' }))
    const response = await link.request({ method: 'GET', path: '/api/board', headers: {} })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ a: 1 })
    // Bytes on the link are never compressed, so a stray encoding is dropped
    // rather than handed to a reader that would try to inflate plain text.
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('x-kept')).toBe('yes')
  })

  it('asks the Mac for identity bytes and keeps the caller\'s token', async () => {
    const { link, rig: r } = await open(answering(204, []))
    const response = await link.request({ method: 'POST', path: '/api/x', headers: { authorization: 'Bearer t' } })
    expect(response.status).toBe(204)
    const opened = r.channel().sent.find((f) => f.t === 'open')
    expect(opened).toMatchObject({
      t: 'open',
      method: 'POST',
      path: '/api/x',
      headers: { authorization: 'Bearer t', 'accept-encoding': 'identity' }
    })
  })

  it('sends a large body in pieces any browser can send, done only on the last', async () => {
    const { link, rig: r } = await open(answering(200, []))
    const body = new Uint8Array(RTC_BODY_CHUNK * 2 + 10).fill(65)
    await link.request({ method: 'POST', path: '/api/attachments', headers: {}, body })
    const bodies = r.channel().sent.filter((f): f is Extract<RelayFrame, { t: 'body' }> => f.t === 'body')
    expect(bodies.map((f) => Buffer.from(f.data, 'base64').byteLength)).toEqual([RTC_BODY_CHUNK, RTC_BODY_CHUNK, 10])
    expect(bodies.map((f) => f.done === true)).toEqual([false, false, true])
  })

  it('sends one empty, finished body for a request with none', async () => {
    const { link, rig: r } = await open(answering(200, []))
    await link.request({ method: 'GET', path: '/api/x', headers: {} })
    expect(r.channel().sent.filter((f) => f.t === 'body')).toEqual([{ t: 'body', id: 'r1', data: '', done: true }])
  })

  it('fails when the Mac gives up before answering', async () => {
    const { link } = await open((frame, reply) => {
      if (frame.t === 'body') reply({ t: 'abort', id: frame.id, reason: 'companion-failed' })
    })
    await expect(link.request({ method: 'GET', path: '/api/x', headers: {} })).rejects.toThrow(/companion-failed/)
  })

  it('tells the Mac to stop when the caller aborts mid-stream', async () => {
    const { link, rig: r } = await open((frame, reply) => {
      if (frame.t === 'body') reply({ t: 'head', id: frame.id, status: 200, headers: {} })
    })
    const abort = new AbortController()
    const response = await link.request({ method: 'GET', path: '/api/events', headers: {}, signal: abort.signal })
    const reading = response.body!.getReader().read()
    abort.abort()
    await expect(reading).rejects.toThrow()
    expect(r.channel().sent.at(-1)).toEqual({ t: 'end', id: 'r1' })
  })

  it('fails every request in flight, and says so once, when the link closes', async () => {
    const { link, rig: r } = await open(() => undefined)
    let closed = 0
    link.onClose(() => void (closed += 1))
    const pending = link.request({ method: 'GET', path: '/api/x', headers: {} })
    r.channel().close()
    await expect(pending).rejects.toThrow(/closed/)
    expect(link.isOpen()).toBe(false)
    link.close()
    expect(closed).toBe(1)
    await expect(link.request({ method: 'GET', path: '/api/x', headers: {} })).rejects.toThrow(/not open/)
  })
})

describe('an event stream over the link', () => {
  const collect = (source: RtcEventSource, types: readonly string[]): string[] => {
    const seen: string[] = []
    for (const type of types) source.addEventListener(type, (e) => void seen.push(`${type}:${(e as MessageEvent).data ?? ''}`))
    return seen
  }

  it('dispatches named events, joins multi-line data, and skips comments', async () => {
    const { link } = await open(
      answering(200, [': hello\n\nevent: board\ndata: {"a"', ':1}\n\nevent: build\r\ndata: one\r\ndata: two\r\n\r\n', 'data: plain\n\n'])
    )
    const source = new RtcEventSource(link, '/api/events')
    const seen = collect(source, ['board', 'build', 'message'])
    const errored = new Promise<void>((resolve) => (source.onerror = () => resolve()))
    await errored
    expect(seen).toEqual(['board:{"a":1}', 'build:one\ntwo', 'message:plain'])
  })

  it('opens, then ends as an error with readyState CLOSED — what makes consumers reconnect', async () => {
    const { link } = await open(answering(200, ['event: x\ndata: 1\n\n']))
    const source = new RtcEventSource(link, '/api/events')
    const states: string[] = []
    source.addEventListener('open', () => void states.push(`open:${source.readyState}`))
    await new Promise<void>((resolve) =>
      source.addEventListener('error', () => {
        states.push(`error:${source.readyState}`)
        resolve()
      })
    )
    expect(states).toEqual(['open:1', 'error:2'])
  })

  it('is an error, never an open, when the Mac refuses the stream', async () => {
    const { link } = await open(answering(401, ['no']))
    const source = new RtcEventSource(link, '/api/events')
    let opened = false
    source.onopen = () => void (opened = true)
    await new Promise<void>((resolve) => (source.onerror = () => resolve()))
    expect(opened).toBe(false)
    expect(source.readyState).toBe(2)
  })

  it('asks for the stream as an event stream', async () => {
    const { link, rig: r } = await open(answering(200, []))
    const source = new RtcEventSource(link, '/api/terminal/t1/stream?token=x')
    await new Promise<void>((resolve) => (source.onerror = () => resolve()))
    expect(r.channel().sent[0]).toMatchObject({
      t: 'open',
      method: 'GET',
      path: '/api/terminal/t1/stream?token=x',
      headers: { accept: 'text/event-stream' }
    })
  })

  it('closes quietly when the consumer closes it', async () => {
    const { link, rig: r } = await open((frame, reply) => {
      if (frame.t === 'body') reply({ t: 'head', id: frame.id, status: 200, headers: {} })
    })
    const source = new RtcEventSource(link, '/api/events')
    await new Promise<void>((resolve) => (source.onopen = () => resolve()))
    let errors = 0
    source.onerror = () => void (errors += 1)
    source.close()
    await new Promise((r2) => setTimeout(r2, 10))
    expect(source.readyState).toBe(2)
    expect(errors).toBe(0)
    expect(r.channel().sent.at(-1)).toEqual({ t: 'end', id: 'r1' })
  })
})
