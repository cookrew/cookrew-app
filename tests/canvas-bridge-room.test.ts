import { describe, expect, it } from 'vitest'
import { createCanvasBridge, type BridgeDialer, type BridgeResponse } from '../src/main/canvas-bridge'
import { decodeFrame, encodeFrame } from '../src/shared/relay-frame'

/**
 * A LANE THAT IS FULL STOPS READING ITS ANSWER. The bridge asks `room` after
 * every read of a local answer; told no, it pauses that answer and resumes it
 * when told to, so an event stream faster than the relay line is held at the
 * companion rather than piling up in this process.
 */

interface Held {
  readonly data: (chunk: Buffer) => void
  readonly end: () => void
  paused: number
  resumed: number
}

/** A companion answer the test feeds by hand. */
const handDialer = (): { dial: BridgeDialer; held: () => Held } => {
  let current: Held | null = null
  const dial: BridgeDialer = (_input, onResponse) => {
    const dataListeners: ((chunk: Buffer) => void)[] = []
    const endListeners: (() => void)[] = []
    const held: Held = {
      data: (chunk) => dataListeners.forEach((listener) => listener(chunk)),
      end: () => endListeners.forEach((listener) => listener()),
      paused: 0,
      resumed: 0
    }
    current = held
    const response: BridgeResponse = {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      onData: (listener) => void dataListeners.push(listener),
      onEnd: (listener) => void endListeners.push(listener),
      pause: () => void (held.paused += 1),
      resume: () => void (held.resumed += 1)
    }
    setImmediate(() => onResponse(response))
    return { write: () => undefined, end: () => undefined, destroy: () => undefined }
  }
  return { dial, held: () => current! }
}

const open = (id: string): string[] => [
  encodeFrame({ t: 'open', id, method: 'GET', path: '/api/events', headers: {} }),
  encodeFrame({ t: 'body', id, data: '', done: true })
]

describe('the bridge and a full lane', () => {
  it('pauses the answer when its lane has no room, and resumes it when told', async () => {
    const { dial, held } = handDialer()
    const sent: string[] = []
    let full = false
    let resume: (() => void) | null = null
    const bridge = createCanvasBridge({
      send: (line) => sent.push(line),
      dial,
      chunk: 4,
      room: (id, then) => {
        expect(id).toBe('s1')
        if (!full) return true
        resume = then
        return false
      }
    })
    open('s1').forEach(bridge.frame)
    await new Promise((resolve) => setImmediate(resolve))
    held().data(Buffer.from('hello'))
    expect(held().paused).toBe(0)
    full = true
    held().data(Buffer.from('world'))
    expect(held().paused).toBe(1)
    // Everything read before the pause still went up, split at the chunk size.
    const chunks = sent.map((line) => decodeFrame(line)).filter((frame) => frame?.t === 'chunk')
    expect(chunks.length).toBe(4)
    resume!()
    expect(held().resumed).toBe(1)
  })

  it('reads as fast as loopback gives it when nobody asks for room', async () => {
    const { dial, held } = handDialer()
    const bridge = createCanvasBridge({ send: () => undefined, dial })
    open('s1').forEach(bridge.frame)
    await new Promise((resolve) => setImmediate(resolve))
    for (let i = 0; i < 10; i += 1) held().data(Buffer.alloc(1024))
    expect(held().paused).toBe(0)
  })
})
