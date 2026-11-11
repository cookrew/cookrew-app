import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterRefusal, UnlockSheetView, type UnlockSheetViewProps } from '../src/renderer/src/use/UnlockSheet'
import { SealRefusedError } from '../src/renderer/src/path/seal-client'
import { hostOutsideTheMac } from '../src/shared/remote-unlock'

const noop = (): void => undefined
const draw = (over: Partial<UnlockSheetViewProps>): string =>
  renderToStaticMarkup(<UnlockSheetView needsCode={false} stale={false} onCode={noop} canRemember trust="same" words={['able', 'baby']} saved={false} busy={false} error={null} password="" remember={false} onPassword={noop} onRemember={noop} onUnlock={noop} onForget={noop} onTrustNew={noop} onClose={noop} {...over} />)

describe('UnlockSheetView', () => {
  it('asks for the password as a password, and offers to remember it', () => {
    const html = draw({})
    expect(html).toContain('type="password"')
    expect(html).toContain('Remember on this device')
  })

  it('shows the key to check the first time, and not after', () => {
    expect(draw({ trust: 'new' })).toContain('able baby')
    expect(draw({ trust: 'same' })).not.toContain('able baby')
  })

  it('a remembered password needs one press, and can be forgotten', () => {
    const html = draw({ saved: true })
    expect(html).not.toContain('type="password"')
    expect(html).toContain('Forget password')
  })

  it('with no connect code it asks for one before any password', () => {
    const html = draw({ needsCode: true })
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('Remember on this device')
    expect(html).toContain('pairing code')
    expect(html).toContain('aria-label="Pairing link"')
  })

  it('keeps no password on a page cookrew.dev serves: one altered page could read it without a keystroke', () => {
    expect(draw({ canRemember: false })).not.toContain('Remember on this device')
    expect(draw({ canRemember: false })).toContain('type="password"')
  })

  it('says when the code it held has been replaced', () => {
    expect(draw({ needsCode: true })).not.toContain('out of date')
    expect(draw({ needsCode: true, stale: true })).toContain('out of date')
    // The machine PROVED it changed the code: said as that, and it still asks for the new one.
    const changed = draw({ needsCode: true, stale: true, changed: true })
    expect(changed).toContain('was changed')
    expect(changed).toContain('Pairing link')
  })

  it('a code the machine refuses, or proves it replaced, gives way to one scanned since; with none, the sheet asks for it', () => {
    for (const why of ['code', 'replaced'] as const) {
      expect(afterRefusal(new SealRefusedError(why), () => 'WAITED')).toEqual({ kind: 'try', code: 'WAITED' })
      expect(afterRefusal(new SealRefusedError(why), () => null)).toEqual({ kind: 'needs-code', stale: true, changed: why === 'replaced' })
    }
  })

  it('any other failure is said as it is, and no waiting code is spent on it', () => {
    let taken = 0
    const take = (): string | null => {
      taken += 1
      return 'WAITED'
    }
    expect(afterRefusal(new SealRefusedError('proof'), take)).toMatchObject({ kind: 'failed' })
    expect(afterRefusal(new Error('The sealed session did not open (502).'), take)).toEqual({ kind: 'failed', message: 'The sealed session did not open (502).' })
    expect(taken).toBe(0)
  })

  it('a changed key takes no password at all', () => {
    const html = draw({ trust: 'changed' })
    expect(html).toContain('key changed')
    expect(html).toContain('Nothing was sent')
    expect(html).not.toContain('type="password"')
  })
})

describe('hostOutsideTheMac', () => {
  it('knows the names cookrew.dev answers for', () => {
    expect(hostOutsideTheMac('cookrew.dev')).toBe(true)
    expect(hostOutsideTheMac('192-168-2-40.abc.d.cookrew.dev:8643')).toBe(true)
    expect(hostOutsideTheMac('192-168-2-40.ABC.D.COOKREW.DEV')).toBe(true)
  })

  it('leaves a bare address and a tailnet name alone', () => {
    expect(hostOutsideTheMac('192.168.2.40:8643')).toBe(false)
    expect(hostOutsideTheMac('[fd7a::1]:8643')).toBe(false)
    expect(hostOutsideTheMac('mac.tail1234.ts.net:8643')).toBe(false)
  })

  it('an unknown host is not a page of the Mac’s own', () => {
    expect(hostOutsideTheMac(undefined)).toBe(true)
  })
})

