import { describe, expect, it } from 'vitest'
import {
  MAX_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
  isDoorPath,
  type RelayFrame
} from '../src/shared/relay-frame'

/**
 * THE RELAY WIRE.
 *
 * Everything here parses data from the other side of a network, so the tests
 * are mostly about what it REFUSES. A relay carries many people's doors on one
 * process: a frame that could throw, allocate without bound, or address a path
 * outside the door would be a way to reach past the team that was published.
 */

const round = (frame: RelayFrame): RelayFrame | null => decodeFrame(encodeFrame(frame))

describe('frames survive the trip', () => {
  it('carries a request, its answer, its chunks and its end', () => {
    const open: RelayFrame = {
      t: 'open',
      id: 's1',
      method: 'POST',
      path: '/ask',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' }
    }
    expect(round(open)).toEqual(open)
    expect(round({ t: 'head', id: 's1', status: 200, headers: { 'content-type': 'text/event-stream' } })).toBeTruthy()
    expect(round({ t: 'chunk', id: 's1', data: 'event: hello\n\n' })).toBeTruthy()
    expect(round({ t: 'end', id: 's1' })).toEqual({ t: 'end', id: 's1' })
    expect(round({ t: 'ready', name: '@drej/cookrew-alpha' })).toBeTruthy()
  })

  it('normalises what the two sides might spell differently', () => {
    const decoded = decodeFrame(
      JSON.stringify({ t: 'open', id: 's1', method: 'post', path: '/ask', headers: { Authorization: 'Bearer x' } })
    )
    expect(decoded).toEqual({
      t: 'open',
      id: 's1',
      method: 'POST',
      path: '/ask',
      headers: { authorization: 'Bearer x' }
    })
  })
})

describe('what it refuses, and why that matters', () => {
  it('never throws on anything a stranger can send', () => {
    for (const raw of ['', 'null', '[]', '{', 'not json', '"string"', '123', '{"t":"nope"}']) {
      expect(() => decodeFrame(raw)).not.toThrow()
      expect(decodeFrame(raw), raw).toBeNull()
    }
  })

  it('refuses a frame bigger than a door should ever buffer', () => {
    const huge = encodeFrame({ t: 'chunk', id: 's1', data: 'x'.repeat(MAX_FRAME_BYTES) })
    expect(huge.length).toBeGreaterThan(MAX_FRAME_BYTES)
    expect(decodeFrame(huge)).toBeNull()
  })

  it('refuses a header map that is an allocation attempt, not a request', () => {
    const headers: Record<string, string> = {}
    for (let i = 0; i < 200; i += 1) headers[`h${i}`] = 'v'
    expect(decodeFrame(JSON.stringify({ t: 'open', id: 's1', method: 'GET', path: '/crew', headers }))).toBeNull()
  })

  it('refuses malformed members rather than repairing them', () => {
    const bad = [
      { t: 'open', id: '', method: 'GET', path: '/crew', headers: {} },
      { t: 'open', id: 's1', method: 'GET', path: '/crew', headers: { a: 1 } },
      { t: 'open', id: 's1', method: 'GET', path: '/crew', headers: [] },
      { t: 'head', id: 's1', status: 999, headers: {} },
      { t: 'head', id: 's1', status: 200.5, headers: {} },
      { t: 'chunk', id: 's1' },
      { t: 'end' },
      { t: 'abort', id: 's1' }
    ]
    for (const frame of bad) {
      expect(decodeFrame(JSON.stringify(frame)), JSON.stringify(frame)).toBeNull()
    }
  })

  it('bounds an abort reason — it is for a log, not a payload', () => {
    const decoded = decodeFrame(JSON.stringify({ t: 'abort', id: 's1', reason: 'x'.repeat(9000) }))
    expect(decoded?.t).toBe('abort')
    if (decoded?.t !== 'abort') return
    expect(decoded.reason.length).toBeLessThanOrEqual(200)
  })
})

describe('a relayed request may only address the door', () => {
  /**
   * THE CONTAINMENT. The connection exists to expose ONE published team. If a
   * caller could name any path, a relay meant to serve a team would expose the
   * whole mobile API — every terminal in every workspace, and the pairing
   * routes — to anyone who could reach the relay.
   */
  it('allows exactly the door surface', () => {
    for (const path of [
      '/',
      '/crew',
      '/api/call/challenge',
      '/api/call/assert',
      '/api/call/pay',
      '/ask',
      '/turns',
      '/trace',
      '/trace/index',
      '/trace/markers',
      '/line',
      '/line/raw',
      '/line/resize'
    ]) {
      expect(isDoorPath(path), path).toBe(true)
    }
    // Query strings belong to the transcript reads and must not change the answer.
    expect(isDoorPath('/trace?afterIndex=3')).toBe(true)
  })

  it('refuses everything else, especially the owner’s own app', () => {
    for (const path of [
      '/api/terminal/abc/stream',
      '/api/terminal/abc/raw',
      '/api/workspace',
      '/api/events',
      '/api/auth/status',
      '/other-team/ask',
      '/../ask',
      '/line/../api/workspace',
      ''
    ]) {
      expect(isDoorPath(path), path).toBe(false)
    }
  })
})
