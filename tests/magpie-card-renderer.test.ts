// THE RENDERER SIDE OF MAGPIE'S CARD: it names the card first, has main sign that
// card in, and saves only the bare address main hands back. A card already named
// "Magpie" is reused, and a stale address on it (a `?k=` from an older build) is
// replaced by the bare one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserNodeData, CanvasNode } from '../src/shared/model'

const BARE = 'http://127.0.0.1:3433/'

function install(nodes: CanvasNode[], open: (id: string) => Promise<unknown>) {
  const added: CanvasNode[] = []
  const updated: { id: string; patch: Partial<CanvasNode> }[] = []
  const api = {
    getWorkspace: vi.fn(async () => ({ nodes })),
    addNode: vi.fn(async (node: CanvasNode) => void added.push(node)),
    updateNode: vi.fn(async (id: string, patch: Partial<CanvasNode>) => void updated.push({ id, patch })),
    magpieWebOpen: vi.fn(open)
  }
  ;(globalThis as { window?: unknown }).window = { cookrew: api }
  return { api, added, updated }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  vi.resetModules()
})

describe('openMagpieSettings', () => {
  it('signs a new card in by its own id and saves only the bare address', async () => {
    const { api, added } = install([], async () => ({ ok: true, url: BARE, port: 3433 }))
    const { openMagpieSettings } = await import('../src/renderer/src/routing/magpie-card')
    expect(await openMagpieSettings()).toBeNull()
    expect(added).toHaveLength(1)
    const card = added[0] as BrowserNodeData
    expect(api.magpieWebOpen).toHaveBeenCalledWith(card.id)
    expect(card).toMatchObject({ kind: 'browser', name: 'Magpie', url: BARE })
    expect(JSON.stringify(added)).not.toContain('?k=')
  })

  it('reuses the card named Magpie and puts the bare address on it', async () => {
    const held: BrowserNodeData = { kind: 'browser', id: 'held-card', name: 'Magpie', url: 'http://127.0.0.1:3433/?k=cookrew-stale', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
    const { api, added, updated } = install([held as CanvasNode], async () => ({ ok: true, url: BARE, port: 3433 }))
    const { openMagpieSettings } = await import('../src/renderer/src/routing/magpie-card')
    expect(await openMagpieSettings()).toBeNull()
    expect(api.magpieWebOpen).toHaveBeenCalledWith('held-card')
    expect(added).toEqual([])
    expect(updated).toEqual([{ id: 'held-card', patch: { url: BARE } }])
  })

  it('adds no card when main refuses, and says why', async () => {
    const { added } = install([], async () => ({ ok: false, why: 'Magpie is switched off in Launch settings.' }))
    const { openMagpieSettings } = await import('../src/renderer/src/routing/magpie-card')
    expect(await openMagpieSettings()).toBe('Magpie is switched off in Launch settings.')
    expect(added).toEqual([])
  })

  it('refuses an answer that carries anything but a bare loopback address', async () => {
    const { added } = install([], async () => ({ ok: true, url: 'http://127.0.0.1:3433/?k=leaked', port: 3433 }))
    const { openMagpieSettings } = await import('../src/renderer/src/routing/magpie-card')
    expect(await openMagpieSettings()).not.toBeNull()
    expect(added).toEqual([])
  })
})
