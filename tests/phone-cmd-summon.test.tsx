// THE PHONE'S SOUS BOX IS SUMMONED, NOT PARKED (reported from a phone,
// IMG_3770, 2026-10-15): the always-on bottom bar covered the dock's tool and
// preset rows. The owner's ruling: hide it on the phone and call it up when
// needed — the desktop's ⌘K contract. The phone has no ⌘K, so the dock grows a
// SOUS button that opens the box, and the box grows a ✕ that closes it.
//
// Static markup, the house way (no jsdom; renderToStaticMarkup over a stubbed
// window, vi.resetModules and a dynamic import because api.ts reads
// module-scope globals once).

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { holdsInbox } from '../src/renderer/src/command-box-feed'

const stubWindow = (): void => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    cookrew: {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
}

const box = async () => {
  vi.resetModules()
  stubWindow()
  return import('../src/renderer/src/CommandBox')
}

const dock = async () => {
  vi.resetModules()
  stubWindow()
  return import('../src/renderer/src/Dock')
}

describe('the phone summons the box', () => {
  it('closed on the phone renders nothing, exactly like the desktop', async () => {
    const { CommandBox } = await box()
    expect(renderToStaticMarkup(<CommandBox open={false} onClose={() => undefined} phone rows={[]} />)).toBe('')
  })

  it('open on the phone is the same box, with a ✕ because there is no Escape key', async () => {
    const { CommandBox } = await box()
    const html = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone rows={[]} />)
    expect(html).toContain('class="cmd phone"')
    expect(html).toContain('aria-label="Close"')
    // the desktop keeps its keyboard: no ✕ there
    expect(renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} />)).not.toContain('aria-label="Close"')
  })

  it('the inbox subscription is held only while the box is open, on every surface', () => {
    expect(holdsInbox({ open: false, phone: true })).toBe(false)
    expect(holdsInbox({ open: true, phone: true })).toBe(true)
    expect(holdsInbox({ open: false, phone: false })).toBe(false)
    expect(holdsInbox({ open: true, phone: false })).toBe(true)
  })
})

describe('the dock offers SOUS on the phone', () => {
  const props = {
    tool: 'terminal' as const,
    onSelect: () => undefined,
    clipping: false,
    onToggleClipping: () => undefined,
    presets: ['claude'],
    templates: [],
    preset: 'claude',
    onPreset: () => undefined,
    roles: [],
    role: null,
    onRole: () => undefined,
    orch: false,
    onOrch: () => undefined,
    connectHint: null,
    voiceFor: null,
    browserFor: null,
    boardFor: null
  }

  it('renders the summon button when given the act, and not otherwise', async () => {
    const { Dock } = await dock()
    const withSous = renderToStaticMarkup(<Dock {...props} onSous={() => undefined} />)
    expect(withSous).toContain('aria-label="SOUS"')
    const without = renderToStaticMarkup(<Dock {...props} />)
    expect(without).not.toContain('aria-label="SOUS"')
  })
})
