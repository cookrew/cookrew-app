import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnlockSheetView, type UnlockSheetViewProps } from '../src/renderer/src/use/UnlockSheet'
import { hostOutsideTheMac } from '../src/shared/remote-unlock'

const noop = (): void => undefined
const draw = (over: Partial<UnlockSheetViewProps>): string =>
  renderToStaticMarkup(<UnlockSheetView relayed={false} trust="same" words={['able', 'baby']} saved={false} busy={false} error={null} password="" remember={false} onPassword={noop} onRemember={noop} onUnlock={noop} onForget={noop} onTrustNew={noop} onClose={noop} {...over} />)

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

  it('a page the relay served never asks for the password', () => {
    const html = draw({ relayed: true })
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('Remember on this device')
    expect(html).toContain('Wi-Fi or Tailscale')
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

