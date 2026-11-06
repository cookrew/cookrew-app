// BOX ROUND 3, BUG 1, THE WHOLE CHAIN. No Chrome on this machine and nothing set:
// pages belong to the webview, and the screen still reaches a viewer. The real
// manager, the real Linux device and pixel instance, and the real cast handshake
// behind the same gate main wires (index.ts · streamsCard). Only the capturer is a
// stand-in, because a test has no display.
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserCast } from '../src/main/browser-cast'
import { mainDrawsCard } from '../src/main/browser-owner'
import { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import { interactiveBrowserDefault } from '../src/main/launch-defaults'
import { LinuxScreenDevice } from '../src/main/linux-screen'
import { PixelInstance, type RemoteGate } from '../src/main/pixel-instance'
import type { BrowserNodeData } from '../src/shared/model'
import { useUrl } from '../src/shared/use-url'

const card = (id: string, url: string): BrowserNodeData => ({
  kind: 'browser',
  id,
  name: id,
  url,
  tabs: [{ id: `${id}-tab`, url, title: '' }],
  activeTabId: `${id}-tab`,
  position: { x: 0, y: 0 },
  size: { width: 720, height: 560 }
})

const jpeg = (width: number, height: number): Buffer => {
  const sof = Buffer.alloc(10)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof])
}

const gate: RemoteGate = {
  blocked: async () => null,
  inputRefusal: () => 'view only',
  agentRefusal: () => 'view only',
  mayDrive: () => false,
  cardControl: () => ({ holder: null, mine: false }) as never,
  admit: () => null,
  enter: () => () => undefined
}

interface TestSocket extends Duplex {
  writes: string[]
}

const socketStub = (): TestSocket => {
  const writes: string[] = []
  const listeners = new Map<string, Set<(value?: unknown) => void>>()
  let destroyed = false
  const emit = (name: string): void => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener()
  }
  const on = (name: string, listener: (value?: unknown) => void): unknown => {
    listeners.set(name, (listeners.get(name) ?? new Set()).add(listener))
    return socket
  }
  const socket = {
    writes,
    get destroyed() {
      return destroyed
    },
    writableLength: 0,
    write: (chunk: unknown) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      return true
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      emit('close')
    },
    on,
    once: on
  }
  return socket as unknown as TestSocket
}

const req = (id: string): IncomingMessage =>
  ({ url: `/api/browser/${id}/stream?w=800&h=600&desktopToken=d`, headers: { 'sec-websocket-key': 'k', host: 'localhost' } }) as unknown as IncomingMessage

const messages = (socket: TestSocket, type: string): Array<Record<string, unknown>> =>
  socket.writes
    .map((write) => /\{"t":"[a-z-]+".*\}/s.exec(write)?.[0])
    .filter((json): json is string => json !== undefined)
    .map((json) => JSON.parse(json) as Record<string, unknown>)
    .filter((message) => message.t === type)

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const run of cleanups.splice(0)) await run()
})

function noChromeBox() {
  const pagesHeadless = interactiveBrowserDefault({}, () => false)
  const nodes = new Map([card('screen', 'screen://main'), card('page', 'https://example.com/')].map((n) => [n.id, n]))
  const chrome = vi.fn()
  const manager = new HeadlessBrowserManager({
    enabled: () => pagesHeadless,
    chromePath: () => null,
    profileRoot: () => '/profiles',
    resolveNode: (id) => nodes.get(id) ?? null,
    onPageState: vi.fn(),
    onTabOpened: vi.fn(),
    onTabClosed: vi.fn(),
    makeInstance: chrome,
    uses: {
      makeInstance: (target) =>
        new PixelInstance({
          url: useUrl(target),
          device: new LinuxScreenDevice(target, {
            remote: gate,
            primaryDisplayId: () => '1',
            frames: async () => [{ displayId: '1', jpeg: jpeg(1600, 1040), width: 1600, height: 1040 }]
          })
        })
    }
  })
  const cast = createBrowserCast({
    enabled: (id) => mainDrawsCard(nodes.get(id), pagesHeadless),
    desktopToken: () => 'd',
    paired: () => true,
    getInstance: (id) => manager.get(id)
  })
  cleanups.push(() => cast.shutdown(), () => manager.shutdown())
  return { cast, chrome, pagesHeadless }
}

describe.skipIf(process.platform === 'win32')('a box with no Chrome and nothing set', () => {
  it('owns no pages in main', () => {
    expect(noChromeBox().pagesHeadless).toBe(false)
  })

  it('streams the screen to a viewer, frame after frame', async () => {
    const { cast, chrome } = noChromeBox()
    const socket = socketStub()
    cast.upgrade(req('screen'), socket)
    expect(socket.writes.join('')).toMatch(/101 Switching Protocols/)
    await vi.waitFor(() => expect(messages(socket, 'status').at(-1)).toMatchObject({ state: 'live', use: 'computer' }), { timeout: 4000 })
    await vi.waitFor(() => expect(messages(socket, 'frame').length).toBeGreaterThan(0), { timeout: 4000 })
    expect(chrome).not.toHaveBeenCalled()
  })

  it('refuses the stream for a page, which stays with its webview', () => {
    const { cast, chrome } = noChromeBox()
    const socket = socketStub()
    cast.upgrade(req('page'), socket)
    expect(socket.destroyed).toBe(true)
    expect(socket.writes.join('')).not.toMatch(/101/)
    expect(chrome).not.toHaveBeenCalled()
  })
})
