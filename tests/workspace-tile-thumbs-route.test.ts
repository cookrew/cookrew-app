// THE WORKSPACES VIEW READS EVERY WORKSPACE'S FRONT PAGE (2026-11-16). Through
// the real `handle`: the owner's console is unslugged, its tiles name browsers
// of workspaces other than the focused one, and those pictures were answered
// "no frame" until that workspace was opened. A slug still reads only its own.
import type http from 'node:http'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handle, type MobileServerDeps } from '../src/main/mobile-server'
import { tempBase } from './support/idv2'

const ROOT = 'the-root-pairing-token-abcdefgh'
const NODES: Record<string, Array<{ id: string; kind: string }>> = {
  focused: [{ id: 'here', kind: 'browser' }],
  other: [{ id: 'there', kind: 'browser' }, { id: 'pane', kind: 'terminal' }]
}
const FRAME = { data: Buffer.from('picture'), type: 'image/jpeg', at: 5, capturedAt: 5 }

let temp: { base: string; clean: () => void }
beforeEach(() => {
  temp = tempBase()
})
afterEach(() => temp.clean())

function exchange(url: string): { request: http.IncomingMessage; response: http.ServerResponse; done: Promise<{ status: number; body: string }> } {
  const request = new EventEmitter() as http.IncomingMessage
  request.method = 'GET'
  request.url = url
  request.headers = { host: '127.0.0.1:8643', authorization: `Bearer ${ROOT}` }
  Object.assign(request, { socket: { remoteAddress: '192.168.2.77' } })
  let status = 0
  let body = ''
  let ended = (): void => undefined
  const done = new Promise<{ status: number; body: string }>((resolve) => {
    ended = () => resolve({ status, body })
  })
  const set: Record<string, string> = {}
  const response = {
    setHeader: (name: string, value: string) => { set[name.toLowerCase()] = value },
    getHeader: (name: string) => set[name.toLowerCase()],
    writeHead(code: number) {
      status = code
      return response
    },
    write(chunk: string | Buffer) {
      body += chunk.toString()
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += chunk.toString()
      ended()
    },
    on: () => response,
    once: () => response,
    removeListener: () => response,
    writableEnded: false,
    destroy: vi.fn()
  } as unknown as http.ServerResponse
  return { request, response, done }
}

const asked: string[] = []
const deps = (): MobileServerDeps =>
  ({
    multiInstance: () => true,
    store: {
      focusedId: 'focused',
      focusedState: { nodes: NODES.focused, edges: [] },
      workspaceState: (id: string) => ({ nodes: NODES[id] ?? [], edges: [] }),
      nodeAcrossWorkspaces: (id: string) => {
        for (const [workspaceId, nodes] of Object.entries(NODES)) {
          const node = nodes.find((entry) => entry.id === id)
          if (node) return { node, workspaceId }
        }
        return undefined
      },
      ownerOf: () => undefined,
      list: () => ({ workspaces: [] }),
      bySlug: (slug: string) => (slug === 'mine' ? { id: 'focused' } : undefined),
      on: () => () => undefined
    },
    ptys: { get: () => null, on: () => () => undefined },
    turns: { list: () => [], on: () => () => undefined },
    activity: { on: () => () => undefined },
    events: { on: () => () => undefined },
    ops: { listWorkspaces: () => [], onUiCommand: () => () => undefined },
    presets: [],
    traces: { latestCheckpoint: () => null },
    interactiveBrowserEnabled: () => true,
    pairingToken: ROOT,
    perDeviceOnly: () => false,
    rendererDir: '/nonexistent',
    browserThumb: () => FRAME,
    browserThumbRequested: (id: string) => void asked.push(id),
    identity: { account: () => null, registryOrigin: () => 'https://cookrew.dev', admitted: { has: () => false, verify: () => null } }
  }) as unknown as MobileServerDeps

async function frames(url: string): Promise<Array<{ id: string; at: number | null }>> {
  const { request, response, done } = exchange(url)
  await handle(request, response, deps())
  const answer = await done
  expect(answer.status).toBe(200)
  return (JSON.parse(answer.body) as { frames: Array<{ id: string; at: number | null }> }).frames.map(({ id, at }) => ({ id, at }))
}

describe('GET /api/browser/thumbs', () => {
  beforeEach(() => void asked.splice(0))

  it("answers the owner's unslugged client for a browser of a workspace that is not focused", async () => {
    expect(await frames('/api/browser/thumbs?ids=here,there,pane,gone')).toEqual([
      { id: 'here', at: 5 },
      { id: 'there', at: 5 },
      { id: 'pane', at: null },
      { id: 'gone', at: null }
    ])
    expect(asked).toEqual(['here', 'there'])
  })

  it('keeps a slugged client to its own workspace', async () => {
    expect(await frames('/mine/api/browser/thumbs?ids=here,there')).toEqual([
      { id: 'here', at: 5 },
      { id: 'there', at: null }
    ])
    expect(asked).toEqual(['here'])
  })
})
