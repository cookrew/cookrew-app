import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PendingPort, PORT_CLOSE, PORT_MESSAGE, PORT_OPEN, PortHub } from '../src/main/daemon/owner-ports'
import { PortRelay, type ShellPort } from '../src/main/shell/bridge'

/**
 * A browser card's MessagePort across the owner link: the daemon's half
 * (owner-ports.ts) and the shell's (bridge.ts · PortRelay).
 */

describe('PortHub (the daemon)', () => {
  const setup = () => {
    const out = vi.fn((_channel: string, _args: readonly unknown[], _essential: boolean) => true)
    const hub = new PortHub(() => out)
    return { hub, out }
  }

  it('holds what port1 posts until port2 is handed over, then relays it under its id', () => {
    const { hub, out } = setup()
    const { port1, port2 } = hub.channel()
    port1.postMessage({ t: 'early' })
    expect(out).not.toHaveBeenCalled()
    expect(hub.handOver('browser-stream:port', { nonce: 'n1' }, [port2])).toBe(true)
    port1.postMessage(new Uint8Array([1, 2]))
    // The open is essential (never dropped for backlog); frames are droppable.
    expect(out.mock.calls).toEqual([
      [PORT_OPEN, [1, 'browser-stream:port', { nonce: 'n1' }], true],
      [PORT_MESSAGE, [1, { t: 'early' }], false],
      [PORT_MESSAGE, [1, new Uint8Array([1, 2])], false]
    ])
  })

  it('delivers the owner\'s messages once started, and closes from either end', () => {
    const { hub, out } = setup()
    const { port1, port2 } = hub.channel()
    hub.handOver('browser-stream:port', {}, [port2])
    const heard = vi.fn()
    const closed = vi.fn()
    port1.on('message', heard)
    port1.on('close', closed)
    hub.fromOwner(PORT_MESSAGE, [1, { t: 'painted' }])
    expect(heard).not.toHaveBeenCalled()
    port1.start()
    expect(heard).toHaveBeenCalledWith({ data: { t: 'painted' } })
    hub.fromOwner(PORT_CLOSE, [1])
    expect(closed).toHaveBeenCalledOnce()
    // and the daemon's own close tells the owner
    const second = hub.channel()
    hub.handOver('browser-stream:port', {}, [second.port2])
    const secondClosed = vi.fn()
    second.port1.on('close', secondClosed)
    second.port1.close()
    expect(out).toHaveBeenLastCalledWith(PORT_CLOSE, [2], true)
    // As MessagePortMain: 'close' is for the remote end going, not for this end's own close().
    expect(secondClosed).not.toHaveBeenCalled()
  })

  it('ends the daemon\'s side when the open could not be sent, so no stream runs into the void', () => {
    const out = vi.fn((channel: string) => channel !== PORT_OPEN)
    const hub = new PortHub(() => out)
    const { port1, port2 } = hub.channel()
    const closed = vi.fn()
    port1.on('close', closed)
    expect(hub.handOver('browser-stream:port', {}, [port2])).toBe(false)
    expect(closed).toHaveBeenCalledOnce()
    port1.postMessage(new Uint8Array([1]))
    expect(out).toHaveBeenCalledTimes(1)
  })

  it('still opens, then closes at once, a port main closed before handing it over', () => {
    const { hub, out } = setup()
    const { port1, port2 } = hub.channel()
    port1.close()
    hub.handOver('browser-stream:port', { nonce: 'n' }, [port2])
    expect(out.mock.calls).toEqual([
      [PORT_OPEN, [1, 'browser-stream:port', { nonce: 'n' }], true],
      [PORT_CLOSE, [1], true]
    ])
  })

  it('closes the ports at once when there is no owner to hand them to', () => {
    const hub = new PortHub(() => null)
    const { port1, port2 } = hub.channel()
    const closed = vi.fn()
    port1.on('close', closed)
    expect(hub.handOver('browser-stream:port', {}, [port2])).toBe(false)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('ignores frames for unknown ports, passes on what is not a port frame, and ends all on closeAll', () => {
    const { hub } = setup()
    expect(hub.fromOwner(PORT_MESSAGE, [99, 'x'])).toBe(true)
    expect(hub.fromOwner('pty:input', ['t1', 'x'])).toBe(false)
    const { port1, port2 } = hub.channel()
    hub.handOver('c', {}, [port2])
    const closed = vi.fn()
    port1.on('close', closed)
    hub.closeAll()
    expect(closed).toHaveBeenCalledOnce()
    expect(port2).toBeInstanceOf(PendingPort)
  })
})

class FakePort extends EventEmitter implements ShellPort {
  posted: unknown[] = []
  started = false
  closed = false
  postMessage(data: unknown): void {
    this.posted.push(data)
  }
  start(): void {
    this.started = true
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

describe('PortRelay (the shell)', () => {
  const setup = (windowUp = true) => {
    const made: FakePort[] = []
    const toWindow = vi.fn(() => windowUp)
    const toDaemon = vi.fn()
    const relay = new PortRelay({
      channel: () => {
        const port1 = new FakePort()
        made.push(port1)
        return { port1, port2: { id: 'port2' } }
      },
      toWindow,
      toDaemon
    })
    return { relay, made, toWindow, toDaemon }
  }

  it('opens a real channel, gives the window port2 as the old main did, and relays both ways', () => {
    const { relay, made, toWindow, toDaemon } = setup()
    expect(relay.fromDaemon('$port:open', [1, 'browser-stream:port', { nonce: 'n1' }])).toBe(true)
    expect(toWindow).toHaveBeenCalledWith('browser-stream:port', { nonce: 'n1' }, [{ id: 'port2' }])
    expect(made[0].started).toBe(true)
    relay.fromDaemon('$port:message', [1, new Uint8Array([9])])
    expect(made[0].posted).toEqual([new Uint8Array([9])])
    made[0].emit('message', { data: { t: 'painted' } })
    expect(toDaemon).toHaveBeenCalledWith('$port:message', [1, { t: 'painted' }])
  })

  it('closes from either end, telling the daemon only when the window closed it', () => {
    const { relay, made, toDaemon } = setup()
    relay.fromDaemon('$port:open', [1, 'c', {}])
    relay.fromDaemon('$port:close', [1])
    expect(made[0].closed).toBe(true)
    expect(toDaemon).not.toHaveBeenCalledWith('$port:close', [1])
    relay.fromDaemon('$port:open', [2, 'c', {}])
    made[1].close()
    expect(toDaemon).toHaveBeenCalledWith('$port:close', [2])
    expect(relay.size).toBe(0)
  })

  it('closes and tells the daemon when there is no window to hand the port to', () => {
    const { relay, made, toDaemon } = setup(false)
    relay.fromDaemon('$port:open', [1, 'c', {}])
    expect(made[0].closed).toBe(true)
    expect(toDaemon).toHaveBeenCalledWith('$port:close', [1])
  })

  it('passes on every other event', () => {
    const { relay } = setup()
    expect(relay.fromDaemon('pty:data:t1', ['x'])).toBe(false)
  })
})

describe('a frame across the real framing', () => {
  it('reaches the window\'s port as the same bytes', async () => {
    const { encodeFrame, decodeLine } = await import('../src/main/daemon/owner-link')
    const jpeg = new Uint8Array(200_000).map((_, i) => i % 251)
    const line = encodeFrame({ t: 'event', channel: PORT_MESSAGE, args: [1, { t: 'frame', seq: 7, jpeg }] })
    const frame = decodeLine(line) as { channel: string; args: unknown[] }
    const port1 = new FakePort()
    const relay = new PortRelay({ channel: () => ({ port1, port2: {} }), toWindow: () => true, toDaemon: vi.fn() })
    relay.fromDaemon(PORT_OPEN, [1, 'browser-stream:port', {}])
    relay.fromDaemon(frame.channel, frame.args)
    const posted = port1.posted[0] as { seq: number; jpeg: Uint8Array }
    expect(posted.seq).toBe(7)
    expect(Buffer.from(posted.jpeg).equals(Buffer.from(jpeg))).toBe(true)
  })
})

describe('the shim\'s MessageChannelMain and the owner window', () => {
  it('relays a port main hands to the owner window, and the owner\'s frames reach port1', async () => {
    vi.resetModules()
    const shim = await import('../src/main/daemon/electron-shim')
    const sink = vi.fn()
    shim.connectOwner(sink)
    const main = new shim.BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } })
    await main.loadFile('/app/out/renderer/index.html')
    const { port1, port2 } = new shim.MessageChannelMain()
    const heard = vi.fn()
    port1.on('message', heard)
    port1.start()
    ;(main.webContents as unknown as { postMessage: (c: string, m: unknown, t: unknown[]) => void }).postMessage('browser-stream:port', { nonce: 'n' }, [port2])
    expect(sink).toHaveBeenCalledWith(PORT_OPEN, [1, 'browser-stream:port', { nonce: 'n' }], true)
    shim.ownerDispatch.send(PORT_MESSAGE, [1, { t: 'painted' }])
    expect(heard).toHaveBeenCalledWith({ data: { t: 'painted' } })
  })
})
