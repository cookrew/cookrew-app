// A MINIMAL WEBSOCKET CLIENT (RFC 6455), for the one thing Alma offers no
// REST route for: stopping a running generation (`stop_generation` on
// /ws/threads; every other request is plain HTTP). It writes text frames and
// reads nothing but the frame headers it must skip, so a pong or an event it
// does not care about costs no memory. The host runs on the app's own Node
// (Electron-as-node 20), which has no global WebSocket.

import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  const head = []
  head.push(0x81) // FIN + text
  if (payload.length < 126) head.push(0x80 | payload.length)
  else if (payload.length < 65536) head.push(0x80 | 126, payload.length >> 8, payload.length & 0xff)
  else head.push(0x80 | 127, 0, 0, 0, 0, payload.length >>> 24, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
  return Buffer.concat([Buffer.from(head), mask, masked])
}

/**
 * Open a WebSocket to `url` (`ws://host:port/path`). Resolves with
 * `{ send(value), close() }` once the handshake is accepted; rejects on any
 * failure, so a caller can say "the server refused" rather than hang.
 */
export function connectWebSocket(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const key = randomBytes(16).toString('base64')
    const socket = connect({ host: target.hostname, port: Number(target.port || 80) })
    let settled = false
    let head = Buffer.alloc(0)
    const fail = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('the WebSocket handshake timed out')), timeoutMs)
    socket.on('error', fail)
    socket.once('connect', () => {
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    })
    socket.on('data', (chunk) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      const response = head.subarray(0, end).toString('latin1')
      const rest = head.subarray(end + 4)
      if (!/^HTTP\/1\.1 101/.test(response)) return fail(new Error(`the WebSocket was refused: ${response.split('\r\n')[0]}`))
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(response)?.[1]
      const expected = createHash('sha1').update(key + GUID).digest('base64')
      if (accept !== expected) return fail(new Error('the WebSocket handshake did not verify'))
      clearTimeout(timer)
      settled = true
      // Frames the server sends are read and dropped (headers and payload):
      // the socket must keep draining or a full buffer would stall it.
      let pending = rest
      let need = 0
      socket.removeAllListeners('data')
      socket.on('data', (data) => {
        pending = Buffer.concat([pending, data])
        for (;;) {
          if (need === 0) {
            if (pending.length < 2) return
            const len = pending[1] & 0x7f
            const header = len === 126 ? 4 : len === 127 ? 10 : 2
            if (pending.length < header) return
            need = (len === 126 ? pending.readUInt16BE(2) : len === 127 ? Number(pending.readBigUInt64BE(2)) : len) + header
          }
          if (pending.length < need) return
          pending = pending.subarray(need)
          need = 0
        }
      })
      socket.on('error', () => undefined)
      resolve({
        send(value) {
          if (!socket.destroyed) socket.write(frame(JSON.stringify(value)))
        },
        close() {
          if (socket.destroyed) return
          // A close frame (opcode 8), then the socket goes.
          socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
          socket.end()
        }
      })
    })
    socket.on('close', () => {
      if (!settled) fail(new Error('the WebSocket closed before the handshake'))
    })
  })
}
