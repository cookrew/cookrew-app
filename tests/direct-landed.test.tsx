// THE LANDING, AFTER THE ONE NAVIGATION.
//
// A phone that pressed OPEN ON WI-FI leaves cookrew.dev and arrives at the
// Mac's own trusted name. Two things have to be true when it gets there, and
// both are about the address bar rather than the page.
//
// IT ARRIVES PAIRED AND THEN CLEAN. The token rides in `?token=`, is read by
// the boot before the first authenticated request, and is taken straight back
// off the URL — the same scrub that has always run for a direct pairing link,
// unchanged and now covering `from=relay` beside it.
//
// IT SAYS WHERE IT CAME FROM, ONCE. The reader typed nothing and the URL they
// know is gone from the bar, so one line explains the swap and promises the
// old address still works. Dismissable, and gone on the next load either way,
// because a note that reappears on every reload is a banner.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  landedFromRelay,
  scrubPairingFromUrl
} from '../src/renderer/src/pairing-scope'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const DIRECT = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`

afterEach(() => vi.resetModules())

describe('the landed URL', () => {
  it('is read as a relayed arrival', () => {
    expect(landedFromRelay('?token=abc&from=relay')).toBe(true)
    expect(landedFromRelay('?from=relay')).toBe(true)
  })

  it('is not read as one for any other value, or none', () => {
    expect(landedFromRelay('?from=qr')).toBe(false)
    expect(landedFromRelay('?token=abc')).toBe(false)
    expect(landedFromRelay('')).toBe(false)
  })

  it('loses the token AND the marker in the one scrub that already ran', () => {
    const clean = scrubPairingFromUrl(`${DIRECT}/?token=secret-token-value&from=relay`)
    expect(clean).toBe(`${DIRECT}/`)
    expect(clean).not.toContain('secret-token-value')
    expect(clean).not.toContain('from=relay')
  })

  it('leaves somebody else’s `from` alone', () => {
    // The name is generic enough to belong to another product's link. Only
    // the value this button writes is ours to remove.
    expect(scrubPairingFromUrl(`${DIRECT}/?from=qr`)).toBeNull()
  })

  it('still returns null for a URL that carried nothing', () => {
    expect(scrubPairingFromUrl(`${DIRECT}/`)).toBeNull()
  })
})

const note = async (search: string): Promise<string> => {
  vi.resetModules()
  const store = await import('../src/renderer/src/landed-note')
  const { DirectLandedNote } = await import('../src/renderer/src/DirectLandedNote')
  store.resetLandedNote(search)
  return renderToStaticMarkup(<DirectLandedNote />)
}

describe('the note on the landed page', () => {
  it('says what happened and that the old address still works', async () => {
    const markup = await note('?token=secret-token-value&from=relay')
    expect(markup).toContain('Opened directly on Wi-Fi.')
    expect(markup).toContain('cookrew.dev/… still works from anywhere.')
    // Never the credential that carried this phone here.
    expect(markup).not.toContain('secret-token-value')
    expect(markup).not.toContain('token')
  })

  it('is nothing at all on an ordinary load', async () => {
    expect(await note('')).toBe('')
    expect(await note('?token=secret-token-value')).toBe('')
  })

  it('goes away when it is dismissed, and stays away', async () => {
    vi.resetModules()
    const store = await import('../src/renderer/src/landed-note')
    const { DirectLandedNote } = await import('../src/renderer/src/DirectLandedNote')
    store.resetLandedNote('?from=relay')
    expect(store.landedDirect()).toBe(true)
    store.dismissLandedNote()
    expect(store.landedDirect()).toBe(false)
    expect(renderToStaticMarkup(<DirectLandedNote />)).toBe('')
  })

  it('is captured before the boot scrubs the URL, so it survives it', async () => {
    vi.resetModules()
    const store = await import('../src/renderer/src/landed-note')
    store.resetLandedNote('?token=secret-token-value&from=relay')
    // What the boot then writes to the address bar.
    expect(scrubPairingFromUrl(`${DIRECT}/?token=secret-token-value&from=relay`)).toBe(`${DIRECT}/`)
    // And the note still knows, because it was read first.
    expect(store.landedDirect()).toBe(true)
  })
})
