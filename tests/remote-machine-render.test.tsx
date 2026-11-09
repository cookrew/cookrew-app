// ANOTHER MACHINE INSIDE THE ZOOM VIEW, RENDERED (owner 2026-11-10, design B):
// the stops as static markup, the house way (no jsdom; a stubbed window, and
// a dynamic import because api.ts reads module-scope globals once).
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const SOLIS = { id: '0f8c7b1e-1234-4abc-9def-0123456789ab', name: 'Solis-Core', os: 'linux' }

beforeAll(() => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    cookrew: { callMachine: vi.fn(async () => ({ status: 0, body: null })) }
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
  vi.resetModules()
})

const card = (over: Record<string, unknown> = {}) => ({
  id: 't-1',
  name: 'Herdr Env',
  preset: 'claude',
  orch: false,
  workspace: { id: 'w-1', name: 'Box Lab' },
  status: 'waiting' as const,
  word: 'needs you',
  words: { text: 'Allow the edit?', tone: 'waiting' as const },
  about: 'Box tests',
  choice: { id: 'm-1', kind: 'menu' as const, question: 'Allow this edit to herdr/config.toml?', sub: null, options: [{ key: '1', label: 'Yes', detail: null }, { key: '2', label: 'No', detail: null }], cursor: 0, escIndex: 1 },
  items: [{ id: 'b-1', kind: 'browser' as const, title: 'Box', host: 'localhost:8643', tint: '#456', initial: 'B' }],
  browsers: 1,
  notes: 0,
  ...over
})

describe('the other machine’s stops', () => {
  it('its workspaces are the zoom’s own tiles; its crew a face each, the waiting one in red', async () => {
    const { RemoteWorkspaces, RemoteCrew } = await import('../src/renderer/src/zoom/RemoteStops')
    const tiles = renderToStaticMarkup(createElement(RemoteWorkspaces, { tiles: [{ id: 'w-1', name: 'Box Lab', active: true, agents: 3, waiting: 1, working: 1, done: 0 }], onOpen: () => undefined }))
    expect(tiles).toContain('zv-mark')
    expect(tiles).toContain('Box Lab')
    const crew = renderToStaticMarkup(createElement(RemoteCrew, { cards: [card(), card({ id: 't-2', name: 'Fan Curve', status: 'idle', word: 'resting', choice: null })], onOpen: () => undefined }))
    expect(crew).toContain('Herdr Env')
    expect(crew).toContain('zv-st waiting')
    expect(crew).toContain('Fan Curve')
    expect(renderToStaticMarkup(createElement(RemoteCrew, { cards: [], onOpen: () => undefined }))).toContain('No agents here yet.')
  })

  it('the box that starts a new agent says which machine it starts on', async () => {
    const { RemoteNewAgent } = await import('../src/renderer/src/zoom/RemoteStops')
    const html = renderToStaticMarkup(createElement(RemoteNewAgent, { machine: SOLIS, workspaceId: 'w-1', onStarted: () => undefined }))
    expect(html).toContain('Start a new agent on Solis-Core')
  })

  it('a card: its words, its menu with the same rows, its items, and a box that says where it sends', async () => {
    const { RemoteCardView } = await import('../src/renderer/src/zoom/RemoteCardView')
    const html = renderToStaticMarkup(createElement(RemoteCardView, { machine: SOLIS, card: card(), onItem: () => undefined, onSent: () => undefined }))
    expect(html).toContain('Herdr Env')
    expect(html).toContain('on Solis-Core')
    expect(html).toContain('Allow this edit to herdr/config.toml?')
    expect(html).toContain('wc-row')
    expect(html).toContain('localhost:8643')
    // A menu with no row to type in takes no words.
    expect(html).toContain('Answer its menu above first')
    const free = renderToStaticMarkup(createElement(RemoteCardView, { machine: SOLIS, card: card({ status: 'working', word: 'working', choice: null }), onItem: () => undefined, onSent: () => undefined }))
    expect(free).toContain('Reply to Herdr Env on Solis-Core')
    expect(free).toContain('Stop')
  })
})

describe('the stage', () => {
  it('nothing outside a machine; inside, the crumbs say whose it is', async () => {
    const { RemoteMachineView } = await import('../src/renderer/src/zoom/RemoteMachineView')
    const { remotePlace } = await import('../src/renderer/src/zoom/remote-machine-store')
    expect(renderToStaticMarkup(createElement(RemoteMachineView))).toBe('')
    remotePlace.enter(SOLIS)
    const html = renderToStaticMarkup(createElement(RemoteMachineView))
    expect(html).toContain('Devices')
    expect(html).toContain('rm-crumb remote')
    expect(html).toContain('on Solis-Core')
    expect(html).toContain('Asking Solis-Core')
    remotePlace.leave()
  })
})
