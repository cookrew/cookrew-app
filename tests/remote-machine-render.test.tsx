// ANOTHER MACHINE, RENDERED: its agent's quick-reply card on the devices stop,
// and the window's view inside it (owner 2026-11-25: that machine's own app, as
// the console draws it), as static markup, the house way (no jsdom; a stubbed
// window, and a dynamic import because api.ts reads module-scope globals once).
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

describe('an agent’s card on another machine', () => {
  it('a card: its words, its menu with the same rows, its items, and no box of its own', async () => {
    const { RemoteCardView } = await import('../src/renderer/src/zoom/RemoteCardView')
    const html = renderToStaticMarkup(createElement(RemoteCardView, { machine: SOLIS, card: card(), onItem: () => undefined, onSent: () => undefined }))
    expect(html).toContain('Herdr Env')
    expect(html).toContain('on Solis-Core')
    expect(html).toContain('Allow this edit to herdr/config.toml?')
    expect(html).toContain('wc-row')
    expect(html).toContain('localhost:8643')
    // Words to it are typed in the pick card's box (RemotePickCard.tsx), not on the card.
    expect(html).not.toContain('<input')
    expect(html).not.toContain('rm-box')
    const free = renderToStaticMarkup(createElement(RemoteCardView, { machine: SOLIS, card: card({ status: 'working', word: 'working', choice: null }), onItem: () => undefined, onSent: () => undefined }))
    expect(free).not.toContain('<input')
    expect(free).toContain('Stop')
  })
})

describe('inside another machine: its own app, as the console draws it', () => {
  it('nothing outside a machine', async () => {
    const { MachineGuestView } = await import('../src/renderer/src/zoom/MachineGuestView')
    expect(renderToStaticMarkup(createElement(MachineGuestView))).toBe('')
  })

  it('inside, a webview in the guest’s own session at that machine’s page, opened where it was asked', async () => {
    const { MachineGuestView } = await import('../src/renderer/src/zoom/MachineGuestView')
    const { remotePlace } = await import('../src/renderer/src/zoom/remote-machine-store')
    remotePlace.enter(SOLIS, { workspace: 'w-1', agent: 't-1' })
    const html = renderToStaticMarkup(createElement(MachineGuestView))
    expect(html).toContain('<webview')
    expect(html).toContain('partition="cookrew-machine"')
    expect(html).toContain(`src="cookrew-machine://${SOLIS.id}/?w=w-1&amp;a=t-1`)
    expect(html).toContain('Opening Solis-Core')
    // None of the tiles, crew or card this window used to draw of it from the watch's routes.
    expect(html).not.toContain('rm-card')
    expect(html).not.toContain('zv-mark')
    remotePlace.leave()
  })
})
