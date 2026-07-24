// Minimal Chrome DevTools Protocol client over a raw TCP socket. Electron's
// main process (Node 20) has no global WebSocket, so we hand-roll the client
// side of RFC 6455: HTTP upgrade handshake, client-masked frames out, unmasked
// server frames in (with continuation reassembly for large screencast frames).
// Zero-dependency. Used to drive a headless Chromium child — NOT the Electron
// webview debugger.

import net from 'node:net'
import { randomBytes } from 'node:crypto'

type EventCb = (params: Record<string, unknown>) => void

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

export class CdpClient {
  private socket: net.Socket | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private readonly listeners = new Map<string, Set<EventCb>>()
  private inbound = Buffer.alloc(0)
  /** Reassembly of a fragmented message (opcode + accumulated payload). */
  private fragOpcode = 0
  private fragChunks: Buffer[] = []
  private transportClosed = false
  onClose: () => void = () => undefined

  async connect(wsUrl: string): Promise<void> {
    const u = new URL(wsUrl)
    const socket = net.connect({ host: u.hostname, port: Number(u.port) })
    this.socket = socket
    this.transportClosed = false
    const key = randomBytes(16).toString('base64')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        try {
          socket.destroy()
        } catch {
          // already closed
        }
        reject(error)
      }
      const onError = (error: Error): void => fail(error)
      const onClose = (): void => fail(new Error('CDP socket closed during handshake'))
      const cleanup = (): void => {
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        socket.removeListener('data', onHandshake)
      }
      socket.on('connect', () => {
        socket.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        )
      })
      const onHandshake = (chunk: Buffer): void => {
        this.inbound = Buffer.concat([this.inbound, chunk])
        const idx = this.inbound.indexOf('\r\n\r\n')
        if (idx === -1) return
        const head = this.inbound.subarray(0, idx).toString()
        if (!/ 101 /.test(head)) {
          return fail(new Error('CDP handshake failed'))
        }
        settled = true
        cleanup()
        this.inbound = this.inbound.subarray(idx + 4)
        socket.on('data', (d) => this.onData(d))
        socket.on('close', this.handleTransportClose)
        socket.on('error', this.handleTransportClose)
        resolve()
        if (this.inbound.length > 0) this.drainFrames()
      }
      socket.once('error', onError)
      socket.once('close', onClose)
      socket.on('data', onHandshake)
    })
  }

  private handleTransportClose = (): void => {
    if (this.transportClosed) return
    this.transportClosed = true
    this.socket = null
    this.rejectPending(new Error('CDP closed'))
    this.onClose()
  }

  private onData(chunk: Buffer): void {
    this.inbound = Buffer.concat([this.inbound, chunk])
    this.drainFrames()
  }

  private drainFrames(): void {
    for (;;) {
      const buf = this.inbound
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        offset = 10
      }
      if (masked) offset += 4 // servers shouldn't mask, but be safe
      if (buf.length < offset + len) return
      const payload = buf.subarray(offset, offset + len)
      this.inbound = buf.subarray(offset + len)

      if (opcode === OP_PING) {
        this.sendFrame(OP_PONG, payload)
        continue
      }
      if (opcode === OP_CLOSE) {
        this.close()
        return
      }
      // Text or a continuation of one — reassemble until FIN.
      if (opcode === OP_TEXT || opcode === OP_CONT) {
        if (opcode === OP_TEXT) {
          this.fragOpcode = OP_TEXT
          this.fragChunks = [payload]
        } else {
          this.fragChunks.push(payload)
        }
        if (fin && this.fragOpcode === OP_TEXT) {
          const message = Buffer.concat(this.fragChunks).toString('utf8')
          this.fragChunks = []
          this.onMessage(message)
        }
      }
    }
  }

  private onMessage(data: string): void {
    let msg: CdpMessage
    try {
      msg = JSON.parse(data) as CdpMessage
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
      else p.resolve(msg.result)
    } else if (typeof msg.method === 'string') {
      const set = this.listeners.get(msg.method)
      if (set) for (const cb of set) cb(msg.params ?? {})
    }
  }

  /** Encode + write a client frame (client frames MUST be masked). */
  private sendFrame(opcode: number, payload: Buffer): void {
    const socket = this.socket
    if (!socket || socket.destroyed) return
    const len = payload.length
    let header: Buffer
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len])
    else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    const mask = randomBytes(4)
    const masked = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4]
    socket.write(Buffer.concat([header, mask, masked]))
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('CDP not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sendFrame(OP_TEXT, Buffer.from(JSON.stringify({ id, method, params: params ?? {} }), 'utf8'))
    })
  }

  on(method: string, cb: EventCb): void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(cb)
  }

  off(method: string, cb: EventCb): void {
    const set = this.listeners.get(method)
    if (!set) return
    set.delete(cb)
    if (set.size === 0) this.listeners.delete(method)
  }

  once(method: string, cb: EventCb): void {
    const wrapped: EventCb = (params) => {
      this.off(method, wrapped)
      cb(params)
    }
    this.on(method, wrapped)
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    try {
      socket?.destroy()
    } catch {
      // already closed
    }
    this.rejectPending(new Error('CDP closed'))
  }

  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }
}
