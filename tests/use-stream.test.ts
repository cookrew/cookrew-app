// A VIEWER OF A USE CARD (renderer/browser-stream.ts, use/UseOverlay.tsx): the
// device status the cast sends, the redial backoff, and the line drawn over
// the frame.
import { describe, expect, it, vi } from 'vitest'
import { parseStreamMessage, reconnectDelayMs } from '../src/renderer/src/browser-stream'

vi.mock('../src/renderer/src/api', () => ({ cookrew: () => ({}), listAgents: async () => [], onAgentRegistry: () => () => undefined }))
const { deviceLine } = await import('../src/renderer/src/use/UseOverlay')

describe('parseStreamMessage · status', () => {
  it('reads the device status, and drops a stranger', () => {
    expect(parseStreamMessage(JSON.stringify({ t: 'status', state: 'offline', message: 'No Android device is attached', use: 'phone', input: true }))).toEqual({
      kind: 'status',
      status: { state: 'offline', message: 'No Android device is attached', use: 'phone', input: true }
    })
    expect(parseStreamMessage(JSON.stringify({ t: 'status', state: 'melting', use: 'phone' }))).toBeNull()
    expect(parseStreamMessage(JSON.stringify({ t: 'status', state: 'live', use: 'browser' }))).toBeNull()
  })
})

describe('reconnectDelayMs', () => {
  it('a second, doubling, never more than ten', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000])
  })
})

describe('deviceLine', () => {
  it('says what the owner needs to know, and nothing when all is well', () => {
    expect(deviceLine(null, false)).toBeNull()
    expect(deviceLine(null, true)).toEqual({ text: 'reconnecting…', tone: 'quiet' })
    expect(deviceLine({ state: 'offline', message: 'Screen Recording is off', use: 'computer', input: false }, false)).toEqual({ text: 'Screen Recording is off', tone: 'warn' })
    expect(deviceLine({ state: 'live', message: null, use: 'computer', input: false }, false)).toEqual({ text: 'view only', tone: 'quiet' })
    expect(deviceLine({ state: 'live', message: null, use: 'hardware', input: false }, false)?.text).toBe('camera · view only')
    expect(deviceLine({ state: 'live', message: null, use: 'phone', input: true }, false)).toBeNull()
  })
})
