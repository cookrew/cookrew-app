// Interactive remote browser — single-instance transport (main process).
//
// A phone opens a WebSocket to /api/browser/:id/stream. Per browser id we run
// ONE headless-Chromium child (headless-chrome.ts) and FAN OUT its screencast
// JPEG frames to every connected client; input from ANY client is dispatched to
// the one shared CDP session. Because it's ONE real (never-composited) Chrome,
// the compositor never idles (frames flow continuously, unlike an occluded
// webview) and cookies/session/DOM are unified — so a human-in-the-loop login
// on one client is instantly visible to the agent and every other client.
//
// FAN-OUT PACING (critical): the instance acks CDP immediately (never upstream
// backpressure — one slow phone must not stall the shared Chrome or other
// viewers). Each client keeps only the LATEST frame and DROPS stale frames when
// its own socket is backed up.
//
// Input is the SAME closed vocabulary as before: sanitizeInput -> CDP Input.*,
// never a raw passthrough, on the unauth LAN server behind a flag.

import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import {
  acceptKey,
  decodeFrame,
  encodeControlFrame,
  encodeTextFrame,
  MAX_CLIENT_FRAME_BYTES,
  OVERSIZED_FRAME,
  OPCODE
} from './ws-frame'
import { sanitizeInput, type MapContext } from '../shared/cast-input'
import { DEFAULT_DRAIN_THRESHOLD } from './screencast-pace'
import { jpegSize } from './jpeg-size'
import { HeadlessInstance, type FrameMeta } from './headless-chrome'

/** What a browser id streams: the URL to open + its persistent profile dir. */
export interface StreamTarget {
  url: string
  profileDir: string
}

export interface BrowserCastDeps {
  /** URL + persistent profile dir for a browser id, or null if unknown. */
  resolveTarget: (browserId: string) => StreamTarget | null
  /** Installed Chrome executable path, or null when none is found. */
  chromePath: () => string | null
  /** Feature flag — the transport is inert unless this returns true. */
  enabled: () => boolean
  /** Test seam: construct the headless instance (defaults to the real one). */
  makeInstance?: (opts: {
    executablePath: string
    profileDir: string
    width: number
    height: number
    url: string
  }) => HeadlessInstance
}

const STREAM_RE = /^\/api\/browser\/([^/]+)\/stream$/
const SIZE_MIN = 320
const SIZE_MAX = 2048

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : fallback
}

/**
 * The Origin (if any) must share the request's Host — the served phone bundle
 * connects same-origin; native/CLI clients send no Origin. A cross-origin web
 * page (CSWSH / DNS-rebinding) is refused. Exported for tests.
 */
export function originAllowed(req: {
  headers: { origin?: string | string[]; host?: string }
}): boolean {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export interface BrowserCast {
  upgrade: (req: IncomingMessage, socket: Duplex) => void
  /** Stop every instance + client (app quit). */
  shutdown: () => void
  activeCount: () => number
}

interface InstanceEntry {
  instance: HeadlessInstance
  clients: Set<ClientConn>
  /** Shared coord-mapping context (one screencast resolution for all clients). */
  ctx: MapContext
  width: number
  height: number
}

export function createBrowserCast(deps: BrowserCastDeps): BrowserCast {
  const instances = new Map<string, InstanceEntry>()
  const starting = new Map<string, Promise<InstanceEntry | null>>()

  async function getOrCreateInstance(
    browserId: string,
    width: number,
    height: number
  ): Promise<InstanceEntry | null> {
    const existing = instances.get(browserId)
    if (existing) return existing
    const pending = starting.get(browserId)
    if (pending) return pending

    const promise = (async (): Promise<InstanceEntry | null> => {
      const chrome = deps.chromePath()
      const target = deps.resolveTarget(browserId)
      if (!chrome || !target) return null
      const instance = (deps.makeInstance ??
        ((o) => new HeadlessInstance(o)))({
        executablePath: chrome,
        profileDir: target.profileDir,
        width,
        height,
        url: target.url
      })
      const entry: InstanceEntry = {
        instance,
        clients: new Set(),
        ctx: { displayScale: 1, viewportWidth: width, viewportHeight: height },
        width,
        height
      }
      instance.onExit = () => teardownInstance(browserId)
      instance.frameListeners.add((data, meta) => onInstanceFrame(entry, data, meta))
      try {
        await instance.start()
      } catch {
        instance.stop()
        return null
      }
      instances.set(browserId, entry)
      return entry
    })()

    starting.set(browserId, promise)
    try {
      return await promise
    } finally {
      starting.delete(browserId)
    }
  }

  function onInstanceFrame(entry: InstanceEntry, base64: string, _meta: FrameMeta): void {
    const size = jpegSize(Buffer.from(base64, 'base64'))
    if (size && entry.width > 0) {
      entry.ctx = {
        displayScale: size.width / entry.width,
        viewportWidth: entry.width,
        viewportHeight: entry.height
      }
    }
    for (const client of entry.clients) client.pushFrame(base64, entry.ctx)
  }

  function teardownInstance(browserId: string): void {
    const entry = instances.get(browserId)
    if (!entry) return
    instances.delete(browserId)
    for (const client of [...entry.clients]) client.close()
    entry.instance.stop()
  }

  function upgrade(req: IncomingMessage, socket: Duplex): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = url.pathname.match(STREAM_RE)
    if (!match) return void socket.destroy()
    const browserId = decodeURIComponent(match[1])
    const key = req.headers['sec-websocket-key']
    if (!deps.enabled() || typeof key !== 'string') return void socket.destroy()
    if (!originAllowed(req)) return void socket.destroy()

    const width = clampInt(url.searchParams.get('w'), SIZE_MIN, SIZE_MAX, 390)
    const height = clampInt(url.searchParams.get('h'), SIZE_MIN, SIZE_MAX, 844)

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    )

    void getOrCreateInstance(browserId, width, height).then((entry) => {
      if (!entry) {
        try {
          socket.write(encodeTextFrame(JSON.stringify({ t: 'error', msg: 'no headless instance' })))
        } catch {
          /* ignore */
        }
        return void socket.destroy()
      }
      const client = new ClientConn(socket, entry)
      entry.clients.add(client)
      client.onClosed = () => {
        entry.clients.delete(client)
        if (entry.clients.size === 0) teardownInstance(browserId)
      }
      client.begin(entry.width, entry.height)
    })
  }

  return {
    upgrade,
    shutdown: () => {
      for (const id of [...instances.keys()]) teardownInstance(id)
    },
    activeCount: () => instances.size
  }
}

/** One connected viewer: paces frames to its own socket, forwards input. */
class ClientConn {
  private inbound: Buffer = Buffer.alloc(0)
  private seq = 0
  private closed = false
  /** Newest frame awaiting a drain (older pending frames are dropped). */
  private latest: string | null = null
  private drainArmed = false
  onClosed: () => void = () => undefined

  constructor(
    private readonly socket: Duplex,
    private readonly entry: InstanceEntry
  ) {
    this.socket.on('data', this.onData)
    this.socket.on('close', this.close)
    this.socket.on('error', this.close)
  }

  begin(w: number, h: number): void {
    this.wsSend(JSON.stringify({ t: 'ready', w, h }))
  }

  /** A new frame from the shared instance — send now, or keep-latest + drop. */
  pushFrame(base64: string, ctx: MapContext): void {
    if (this.closed) return
    const msg = JSON.stringify({
      t: 'frame',
      seq: (this.seq += 1),
      data: base64,
      meta: {
        deviceWidth: ctx.viewportWidth,
        deviceHeight: ctx.viewportHeight,
        displayScale: ctx.displayScale
      }
    })
    if (this.socket.writableLength <= DEFAULT_DRAIN_THRESHOLD) {
      this.wsSend(msg)
    } else {
      // Backed up: keep only the newest frame; a stale one helps nobody.
      this.latest = msg
      this.armDrain()
    }
  }

  private armDrain(): void {
    if (this.drainArmed) return
    this.drainArmed = true
    this.socket.once('drain', () => {
      this.drainArmed = false
      const pending = this.latest
      this.latest = null
      if (pending && !this.closed) this.wsSend(pending)
    })
  }

  private onData = (chunk: Buffer): void => {
    this.inbound = Buffer.concat([this.inbound, chunk])
    if (this.inbound.length > MAX_CLIENT_FRAME_BYTES + 16) return this.close()
    for (;;) {
      const frame = decodeFrame(this.inbound)
      if (frame === OVERSIZED_FRAME) return this.close()
      if (!frame) break
      this.inbound = frame.rest
      if (frame.opcode === OPCODE.close) return this.close()
      if (frame.opcode === OPCODE.ping) {
        this.socket.write(encodeControlFrame(OPCODE.pong, frame.payload))
        continue
      }
      if (frame.opcode === OPCODE.text) this.handleInput(frame.payload.toString('utf8'))
    }
  }

  private handleInput(text: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const commands = sanitizeInput(msg, this.entry.ctx) // whitelist + clamp (SECURITY)
    if (!commands) return
    for (const command of commands) this.entry.instance.dispatchInput(command.method, command.params)
  }

  private wsSend(msg: string): void {
    if (this.closed) return
    try {
      this.socket.write(encodeTextFrame(msg))
    } catch {
      this.close()
    }
  }

  close = (): void => {
    if (this.closed) return
    this.closed = true
    this.latest = null
    try {
      this.socket.destroy()
    } catch {
      /* already closed */
    }
    this.onClosed()
  }
}
