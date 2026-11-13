// ⋯ → Agent light: how the crew is lit at rest, kept on this device (zoom/fold-light.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
})

describe('the agent light', () => {
  it('is hover only until another is picked, and keeps a pick', async () => {
    const light = await import('../src/renderer/src/zoom/fold-light')
    expect(light.foldLight()).toBe('hover')
    const heard: string[] = []
    light.subscribeFoldLight(() => heard.push(light.foldLight()))
    light.setFoldLight('terrain')
    expect(light.foldLight()).toBe('terrain')
    expect(heard).toEqual(['terrain'])
    expect(store.get('cookrew.fold-light')).toBe('terrain')
  })

  it('reads a kept pick at load, and anything else as hover only', async () => {
    store.set('cookrew.fold-light', 'every')
    expect((await import('../src/renderer/src/zoom/fold-light')).foldLight()).toBe('every')
    vi.resetModules()
    store.set('cookrew.fold-light', 'sparkles')
    expect((await import('../src/renderer/src/zoom/fold-light')).foldLight()).toBe('hover')
  })
})
