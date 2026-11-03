import { describe, expect, it, vi } from 'vitest'
import { portLine, socketLine, type BrowserStreamPortHandlers } from '../src/renderer/src/stream-line'

describe('the port line (the desktop’s)', () => {
  function harness() {
    let handlers: BrowserStreamPortHandlers | null = null
    const posted: unknown[] = []
    const close = vi.fn()
    const open = vi.fn((_id: string, h: BrowserStreamPortHandlers) => {
      handlers = h
      return { post: (message: unknown) => void posted.push(message), close }
    })
    const events = { opened: 0, messages: [] as unknown[], closed: 0 }
    const line = portLine(open, 'card-1', {
      onOpen: () => void (events.opened += 1),
      onMessage: (message) => void events.messages.push(message),
      onClose: () => void (events.closed += 1)
    })
    return { line, posted, close, open, events, port: () => handlers as unknown as BrowserStreamPortHandlers }
  }

  it('is direct, and sends nothing until main has answered with the port', () => {
    const { line, posted, port, events } = harness()
    expect(line.direct).toBe(true)
    expect(line.isOpen()).toBe(false)
    line.send({ t: 'viewport-offer' })
    expect(posted).toEqual([])
    port().onOpen()
    expect(events.opened).toBe(1)
    line.send({ t: 'painted', seq: 1 })
    expect(posted).toEqual([{ t: 'painted', seq: 1 }])
  })

  it('parses what main posts — bytes stay bytes — and drops junk', () => {
    const { port, events } = harness()
    port().onOpen()
    const jpeg = new Uint8Array([0xff, 0xd8])
    port().onMessage({ t: 'frame', seq: 1, jpeg, meta: { revision: 1 } })
    port().onMessage({ t: 'nonsense' })
    expect(events.messages).toEqual([{ kind: 'frame', seq: 1, bytes: jpeg, revision: 1 }])
  })

  it('a close from main is reported once; our own close is not reported and closes the port', () => {
    const first = harness()
    first.port().onOpen()
    first.port().onClose()
    first.port().onClose()
    expect(first.events.closed).toBe(1)
    expect(first.line.isOpen()).toBe(false)

    const second = harness()
    second.port().onOpen()
    second.line.close()
    expect(second.close).toHaveBeenCalledTimes(1)
    second.port().onMessage({ t: 'copy', text: 'late' })
    expect(second.events.messages).toEqual([])
    expect(second.events.closed).toBe(0)
  })
})

describe('the socket line (the phone’s)', () => {
  function fakeSocket() {
    const socket = {
      readyState: 0,
      sent: [] as string[],
      send: (text: string) => void socket.sent.push(text),
      close: vi.fn(),
      onopen: null as null | (() => void),
      onerror: null as null | (() => void),
      onclose: null as null | (() => void),
      onmessage: null as null | ((event: { data: unknown }) => void)
    }
    return socket
  }

  it('sends JSON only while open, parses text frames, and reports one close for error+close', () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const socket = fakeSocket()
    const events = { opened: 0, messages: [] as unknown[], closed: 0 }
    const line = socketLine(socket as unknown as WebSocket, {
      onOpen: () => void (events.opened += 1),
      onMessage: (message) => void events.messages.push(message),
      onClose: () => void (events.closed += 1)
    })
    expect(line.direct).toBe(false)
    line.send({ t: 'x' })
    expect(socket.sent).toEqual([])
    socket.readyState = 1
    socket.onopen?.()
    line.send({ t: 'painted', seq: 1 })
    expect(socket.sent).toEqual(['{"t":"painted","seq":1}'])
    socket.onmessage?.({ data: '{"t":"frame","seq":2,"data":"Zm9v","meta":{}}' })
    expect(events.messages).toEqual([{ kind: 'frame', seq: 2, src: 'data:image/jpeg;base64,Zm9v' }])
    socket.onerror?.()
    socket.onclose?.()
    expect(events.closed).toBe(1)
    vi.unstubAllGlobals()
  })

  it('our own close detaches every handler before closing the socket', () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const socket = fakeSocket()
    const onClose = vi.fn()
    const line = socketLine(socket as unknown as WebSocket, { onOpen: vi.fn(), onMessage: vi.fn(), onClose })
    line.close()
    expect(socket.onclose).toBeNull()
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
