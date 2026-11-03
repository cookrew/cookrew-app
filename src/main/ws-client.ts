/**
 * A WEBSOCKET CLIENT TO THIS MAC'S OWN COMPANION SERVER — the other half of
 * ws-frame.ts, which only ever spoke as the server.
 *
 * The WebRTC link carries the browser card's stream (rtc-peer.ts), and Node
 * 20 under Electron has no WebSocket client of its own. So this dials the
 * upgrade on loopback the way canvas-bridge dials HTTP, sends masked text
 * frames (a server must refuse unmasked ones) and reads the server's
 * unmasked frames of any length up to a cap. Text, close and ping are the
 * whole of what the browser cast speaks.
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { acceptKey, OPCODE } from './ws-frame'

/** Server frames past this end the socket: a screencast frame is well under it. */
export const WS_CLIENT_FRAME_MAX = 16 * 1024 * 1024

/** One client frame, masked as RFC 6455 requires. */
export const encodeMaskedFrame = (opcode: number, payload: Buffer): Buffer => {
  const len = payload.length
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, 0x80 | len])
      : len < 65536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff])
        : (() => {
            const b = Buffer.alloc(10)
            b[0] = 0x80 | opcode
            b[1] = 0x80 | 127
            b.writeBigUInt64BE(BigInt(len), 2)
            return b
          })()
  const mask = randomBytes(4)
  const body = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) body[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([head, mask, body])
}

export interface ServerFrame {
  readonly fin: boolean
  readonly opcode: number
  readonly payload: Buffer
  readonly rest: Buffer
}

/** One unmasked server frame off the front of `buf`; null until it is all there; 'oversized' past the cap. */
export const decodeServerFrame = (buf: Buffer, max: number = WS_CLIENT_FRAME_MAX): ServerFrame | 'oversized' | null => {
  if (buf.length < 2) return null
  const fin = (buf[0] & 0x80) !== 0
  const opcode = buf[0] & 0x0f
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  if (len > max) return 'oversized'
  if ((buf[1] & 0x80) !== 0) return 'oversized' // a server never masks
  if (buf.length < offset + len) return null
  return { fin, opcode, payload: buf.subarray(offset, offset + len), rest: buf.subarray(offset + len) }
}

export interface LoopbackSocket {
  readonly send: (text: string) => void
  readonly close: () => void
  /** Stop and restart reading, so a slow far end slows the server down. */
  readonly pause: () => void
  readonly resume: () => void
}

export interface LoopbackSocketDeps {
  readonly port: number
  readonly path: string
  readonly headers?: Record<string, string>
  readonly onOpen: () => void
  readonly onMessage: (text: string) => void
  readonly onClose: () => void
}

export const dialLoopbackSocket = (deps: LoopbackSocketDeps): LoopbackSocket => {
  const key = randomBytes(16).toString('base64')
  let socket: import('node:net').Socket | null = null
  let closed = false
  let inbound: Buffer = Buffer.alloc(0)
  let fragments: Buffer[] = []

  const end = (): void => {
    if (closed) return
    closed = true
    socket?.destroy()
    deps.onClose()
  }

  const read = (chunk: Buffer): void => {
    inbound = inbound.length === 0 ? chunk : Buffer.concat([inbound, chunk])
    for (;;) {
      const frame = decodeServerFrame(inbound)
      if (frame === null) return
      if (frame === 'oversized') return end()
      inbound = Buffer.from(frame.rest)
      if (frame.opcode === OPCODE.close) return end()
      if (frame.opcode === OPCODE.ping) {
        socket?.write(encodeMaskedFrame(OPCODE.pong, Buffer.from(frame.payload)))
        continue
      }
      if (frame.opcode === OPCODE.text || frame.opcode === OPCODE.continuation) {
        fragments.push(Buffer.from(frame.payload))
        if (!frame.fin) continue
        const text = Buffer.concat(fragments).toString('utf8')
        fragments = []
        deps.onMessage(text)
      }
    }
  }

  const request = http.request({
    host: '127.0.0.1',
    port: deps.port,
    path: deps.path,
    headers: {
      ...deps.headers,
      host: `127.0.0.1:${deps.port}`,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': key
    }
  })
  request.on('upgrade', (response, upgraded, head) => {
    if (closed) return void upgraded.destroy()
    if (response.headers['sec-websocket-accept'] !== acceptKey(key)) {
      upgraded.destroy()
      return end()
    }
    socket = upgraded
    upgraded.on('data', read)
    upgraded.on('close', end)
    upgraded.on('error', end)
    deps.onOpen()
    if (head.length > 0) read(head)
  })
  request.on('response', (response) => {
    response.resume()
    end()
  })
  request.on('error', end)
  request.end()

  return {
    send: (text) => {
      if (!closed && socket) socket.write(encodeMaskedFrame(OPCODE.text, Buffer.from(text, 'utf8')))
    },
    close: () => {
      if (!closed && socket) socket.write(encodeMaskedFrame(OPCODE.close, Buffer.alloc(0)))
      end()
    },
    pause: () => void socket?.pause(),
    resume: () => void socket?.resume()
  }
}
