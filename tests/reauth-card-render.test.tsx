// THE NOT PAIRED CARD IS NOW THE ONLY PAIRING SURFACE.
//
// Reach v2.1 took SCAN QR, TYPE KEY, the key field and LINK off the /me
// Desktops row, so this card is where a phone is paired — and copy that only
// exists in a constant is copy nobody can pair with. A static render runs the
// component body and the markup IS the picture, so the four things the owner
// specified are asserted on the markup: the title, the sentence that names
// both routes to the credential, the field label and the button.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const stubPhone = (): void => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin: 'https://cookrew.dev', search: '', hash: '', href: 'https://cookrew.dev/' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState: () => undefined },
    setTimeout: () => 0,
    clearTimeout: () => undefined
  }
}

/** The card, rendered in whichever blocked state is asked for. */
const card = async (scope: 'none' | 'read-only'): Promise<string> => {
  stubPhone()
  vi.resetModules()
  const gate = await import('../src/renderer/src/auth-gate')
  const { ReauthOverlay } = await import('../src/renderer/src/ReauthOverlay')
  gate.authStore().report(new gate.AuthError('refused', scope))
  return renderToStaticMarkup(<ReauthOverlay />)
}

afterEach(() => vi.resetModules())

describe('the Not paired card', () => {
  it('says what it is and names both ways to the credential', async () => {
    const markup = await card('none')
    expect(markup).toContain('Not paired')
    // The QR route first — it is the one that needs no typing — and the CLI
    // route for a phone that cannot scan.
    expect(markup).toContain('Scan the QR on the Mac&#x27;s avatar')
    expect(markup).toContain('Pair a phone')
    expect(markup).toContain('cookrew mobile')
  })

  it('carries the field label and the PAIR button', async () => {
    // Both read uppercase on screen; .cr-reauth-label and .cr-btn own that,
    // so the markup stays sentence case and the CSS stays the single place
    // the companion's small-caps voice is decided.
    const markup = await card('none')
    expect(markup).toContain('Pairing URL or token')
    expect(markup).toContain('>Pair</button>')
  })

  it('keeps the credential out of autofill and off the keyboard’s memory', async () => {
    const markup = await card('none')
    expect(markup).toContain('type="password"')
    expect(markup).toContain('autoComplete="off"')
  })

  it('leaves the read-only device wording exactly as it was', async () => {
    const markup = await card('read-only')
    expect(markup).toContain('Read-only device')
    expect(markup).toContain('This device is paired read-only.')
    expect(markup).toContain('Continue read-only')
  })
})
