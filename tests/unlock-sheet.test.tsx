import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnlockSheetView, type UnlockSheetViewProps } from '../src/renderer/src/use/UnlockSheet'

const noop = (): void => undefined
const draw = (over: Partial<UnlockSheetViewProps>): string =>
  renderToStaticMarkup(<UnlockSheetView trust="same" words={['able', 'baby']} saved={false} busy={false} error={null} password="" remember={false} onPassword={noop} onRemember={noop} onUnlock={noop} onForget={noop} onTrustNew={noop} onClose={noop} {...over} />)

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

  it('a changed key takes no password at all', () => {
    const html = draw({ trust: 'changed' })
    expect(html).toContain('key changed')
    expect(html).toContain('Nothing was sent')
    expect(html).not.toContain('type="password"')
  })
})
