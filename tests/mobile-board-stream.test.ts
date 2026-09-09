import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import type { BoardSources } from '../src/main/board-index'

/**
 * The SSE board frame is OPT-IN (?board=1), and a stream that opts in is a
 * board CONSUMER: it holds the probe open for its lifetime and is pushed on
 * the probe's changes. A plain /api/events stream carries no board frame
 * and touches the probe not at all — nothing renders that frame today, and
 * it was a whole-fleet recompute per signal per phone.
 */
const TOKEN = 'pairing-token-123'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function stream(query: string) {
  const frames: string[] = []
  const response = Object.assign(new EventEmitter(), {
    writeHead: () => response,
    write: (chunk: string) => (frames.push(chunk), true),
    end: () => response.emit('close'),
    destroy: () => response.emit('close'),
    req: undefined
  }) as unknown as http.ServerResponse & EventEmitter
  const request = Object.assign(Readable.from([]) as http.IncomingMessage, {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  return { request, response, frames, url: new URL(`http://lan.local/api/events${query}`), close: () => request.emit('close') }
}

function fixture() {
  let subscribers = 0
  const listeners = new Set<() => void>()
  const board: BoardSources = {
    activeWorkspaceId: () => 'ws',
    live: () => [],
    ledger: () => new Map(),
    registry: () => [],
    probe: () => new Map(),
    probeWarm: async () => new Map(),
    probeSubscribe: () => {
      subscribers += 1
      return () => void (subscribers -= 1)
    },
    probeOnChange: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
  const turns = Object.assign(new EventEmitter(), { list: () => [] })
  const store = Object.assign(new EventEmitter(), { focusedState: { nodes: [] } })
  const deps = {
    pairingToken: TOKEN,
    board,
    turns,
    store,
    ops: { listWorkspaces: () => ({ workspaces: [], activeId: 'ws' }) }
  } as unknown as MobileApiDeps
  return { deps, subscribers: () => subscribers, fire: () => listeners.forEach((l) => l()), listeners: () => listeners.size }
}

describe('/api/events and the board frame', () => {
  it('a plain stream carries no board frame and holds no probe', async () => {
    const f = fixture()
    const s = stream('')
    void handleMobileApi(s.request, s.response, s.url, f.deps)
    await sleep(20)
    expect(s.frames.some((x) => x.startsWith('event: board'))).toBe(false)
    expect(f.subscribers()).toBe(0)
    expect(f.listeners()).toBe(0)
    s.close()
  })

  it('?board=1 gets the frame, holds the probe, is pushed on change, and releases on close', async () => {
    const f = fixture()
    const s = stream('?board=1')
    void handleMobileApi(s.request, s.response, s.url, f.deps)
    await sleep(20)
    expect(s.frames.filter((x) => x.startsWith('event: board'))).toHaveLength(1)
    expect(f.subscribers()).toBe(1)
    expect(f.listeners()).toBe(1)
    f.fire() // the probe changed (the frame itself is de-duplicated by digest when identical)
    await sleep(600)
    expect(f.subscribers()).toBe(1)
    s.close()
    await sleep(5)
    expect(f.subscribers()).toBe(0)
    expect(f.listeners()).toBe(0)
  })
})
