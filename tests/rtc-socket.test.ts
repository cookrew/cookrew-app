// A WEBSOCKET ON THE DIRECT LINK (round P2): the browser card's live view,
// which the relay cannot carry. Pieces that join back into whole messages,
// a WebSocket-shaped stand-in on a data channel, and the opener that picks it.
import { afterEach, describe, expect, it } from 'vitest'
import {
  createJoiner,
  RTC_SOCKET_PIECE,
  socketLabel,
  socketPathOf,
  splitMessage
} from '../src/shared/rtc-socket-chunks'
import { RtcWebSocket, type SocketChannel } from '../src/renderer/src/path/rtc-socket'

describe('pieces', () => {
  it('is one piece for a short message and joins back to it', () => {
    const seen: string[] = []
    const join = createJoiner((text) => void seen.push(text))
    for (const piece of splitMessage('{"t":"ready"}')) join(piece)
    expect(splitMessage('{"t":"ready"}')).toHaveLength(1)
    expect(seen).toEqual(['{"t":"ready"}'])
  })

  it('splits a frame-sized message into pieces no larger than the limit, in order', () => {
    const frame = `{"t":"frame","data":"${'A'.repeat(300 * 1024)}"}`
    const pieces = splitMessage(frame)
    expect(pieces.length).toBeGreaterThan(18)
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(RTC_SOCKET_PIECE + 1)
    const seen: string[] = []
    const join = createJoiner((text) => void seen.push(text))
    for (const piece of pieces) expect(join(piece)).toBe(true)
    expect(seen).toEqual([frame])
  })

  it('never cuts a surrogate pair in two', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(20)}`
    const pieces = splitMessage(text, 10)
    const seen: string[] = []
    const join = createJoiner((t) => void seen.push(t))
    for (const piece of pieces) join(piece)
    expect(seen).toEqual([text])
    // Every piece is well-formed on its own, which is what survives UTF-8.
    for (const piece of pieces) expect(new TextDecoder().decode(new TextEncoder().encode(piece))).toBe(piece)
  })

  it('refuses a piece with no mark, and a message past the cap', () => {
    const join = createJoiner(() => undefined, 10)
    expect(join('no mark')).toBe(false)
    expect(join(`+${'x'.repeat(6)}`)).toBe(true)
    expect(join(`=${'x'.repeat(6)}`)).toBe(false)
  })

  it('names the path in the label, and reads only its own labels back', () => {
    expect(socketPathOf(socketLabel('/api/browser/b1/stream?token=t'))).toBe('/api/browser/b1/stream?token=t')
    expect(socketPathOf('cookrew-bridge')).toBeNull()
    expect(socketPathOf('cookrew-ws nope')).toBeNull()
  })
})

class FakeChannel extends EventTarget implements SocketChannel {
  readyState = 'connecting'
  readonly sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }
  deliver(text: string): void {
    for (const piece of splitMessage(text)) this.dispatchEvent(new MessageEvent('message', { data: piece }))
  }
}

describe('the WebSocket stand-in', () => {
  it('opens with the channel, and speaks whole messages both ways', () => {
    const channel = new FakeChannel()
    const ws = new RtcWebSocket(() => channel)
    const events: string[] = []
    ws.onopen = () => void events.push(`open:${ws.readyState}`)
    ws.onmessage = (e) => void events.push(`msg:${String(e.data).length}`)
    expect(ws.readyState).toBe(RtcWebSocket.CONNECTING)
    channel.open()
    channel.deliver('x'.repeat(40_000))
    ws.send('y'.repeat(20_000))
    expect(events).toEqual(['open:1', 'msg:40000'])
    expect(channel.sent).toHaveLength(2)
    expect(channel.sent.join('')).toContain('y'.repeat(100))
  })

  it('refuses to send before it is open, as a WebSocket does', () => {
    const ws = new RtcWebSocket(() => new FakeChannel())
    expect(() => ws.send('early')).toThrow()
  })

  it('closes once, with onclose, when the channel goes', () => {
    const channel = new FakeChannel()
    const ws = new RtcWebSocket(() => channel)
    let closes = 0
    let errors = 0
    ws.onclose = () => void (closes += 1)
    ws.onerror = () => void (errors += 1)
    channel.open()
    channel.close()
    ws.close()
    expect(ws.readyState).toBe(RtcWebSocket.CLOSED)
    expect([closes, errors]).toEqual([1, 0])
  })

  it('fails like a socket that could not connect when the link is already gone', async () => {
    const ws = new RtcWebSocket(() => {
      throw new Error('closed')
    })
    const seen: string[] = []
    ws.onerror = () => void seen.push('error')
    ws.onclose = () => void seen.push('close')
    await Promise.resolve()
    expect(seen).toEqual(['error', 'close'])
  })
})

describe('the opener', () => {
  afterEach(async () => {
    const plane = await import('../src/renderer/src/data-plane')
    const rtc = await import('../src/renderer/src/rtc-plane')
    plane.resetDataPlane()
    rtc.setRtcLink(null)
  })

  it('opens the socket on the link when the plane is the link, at the Mac path', async () => {
    const plane = await import('../src/renderer/src/data-plane')
    const rtc = await import('../src/renderer/src/rtc-plane')
    const asked: string[] = []
    const link = {
      via: '192.168.2.40',
      request: () => new Promise<Response>(() => undefined),
      openSocket: (path: string) => {
        asked.push(path)
        return new RtcWebSocket(() => new FakeChannel())
      },
      isOpen: () => true,
      onClose: () => () => undefined,
      close: () => undefined,
      ended: () => null,
      check: () => undefined
    }
    rtc.setRtcLink(link)
    plane.setDataPlane({ origin: '', kind: 'lan', transport: 'rtc' })
    const ws = rtc.openWebSocket('/api/browser/b1/stream?w=390&h=700&token=t')
    expect(ws).toBeInstanceOf(RtcWebSocket)
    expect(asked).toEqual(['/api/browser/b1/stream?w=390&h=700&token=t'])
  })
})
