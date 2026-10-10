// A WEBSOCKET THAT SAYS HELLO AND HANGS UP: the handshake, and nothing else.
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { answerSocketHello, socketAccept, SOCKET_HELLO_PATH } from '../src/main/socket-hello'

const fakeSocket = () => {
  const chunks: Buffer[] = []
  let ended = false
  const socket = {
    write: (chunk: string | Buffer) => void chunks.push(Buffer.from(chunk)),
    end: (chunk?: string | Buffer) => {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      ended = true
    }
  } as unknown as Duplex
  return { socket, written: () => Buffer.concat(chunks), ended: () => ended }
}

const request = (url: string, headers: Record<string, string>): IncomingMessage =>
  ({ url, headers, method: 'GET' }) as unknown as IncomingMessage

describe('answerSocketHello', () => {
  it('computes the RFC 6455 accept value', () => {
    // The example from the RFC itself.
    expect(socketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('answers 101 with the accept key, then closes cleanly, and reads nothing', () => {
    const { socket, written, ended } = fakeSocket()
    expect(
      answerSocketHello(request(`${SOCKET_HELLO_PATH}?x=1`, { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }), socket)
    ).toBe(true)
    const text = written().toString('latin1')
    expect(text.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true)
    expect(text).toContain('sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n')
    // The close frame: FIN+close opcode, length 2, code 1000.
    expect(written().subarray(-4)).toEqual(Buffer.from([0x88, 0x02, 0x03, 0xe8]))
    expect(ended()).toBe(true)
  })

  it('is not its business for any other path', () => {
    const { socket, written } = fakeSocket()
    expect(answerSocketHello(request('/api/browser/1/stream', { 'sec-websocket-key': 'k' }), socket)).toBe(false)
    expect(written().length).toBe(0)
  })

  it('refuses a handshake with no key', () => {
    const { socket, written, ended } = fakeSocket()
    expect(answerSocketHello(request(SOCKET_HELLO_PATH, {}), socket)).toBe(true)
    expect(written().toString().startsWith('HTTP/1.1 400')).toBe(true)
    expect(ended()).toBe(true)
  })
})
