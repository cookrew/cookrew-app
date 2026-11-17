import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnlockGrantSheetView } from '../src/renderer/src/use/UnlockGrantSheet'
import { UnlockGrantPromptView } from '../src/renderer/src/use/UnlockGrantPrompt'

const noop = (): void => undefined

describe('UnlockGrantSheetView', () => {
  it('shows the words to compare, and where they are compared', () => {
    const html = renderToStaticMarkup(<UnlockGrantSheetView phase={{ kind: 'waiting', words: ['able', 'baby', 'cable', 'dance'] }} onRetry={noop} onClose={noop} />)
    expect(html).toContain('able baby cable dance')
    expect(html).toContain('on the Mac, or on a device that can already unlock it')
    expect(html).toContain('>Cancel<')
  })

  it('says who allowed it, and a failure offers another try', () => {
    expect(renderToStaticMarkup(<UnlockGrantSheetView phase={{ kind: 'done', by: 'Console on Android phone' }} onRetry={noop} onClose={noop} />)).toContain('allowed by Console on Android phone')
    const failed = renderToStaticMarkup(<UnlockGrantSheetView phase={{ kind: 'failed', message: 'Not allowed.' }} onRetry={noop} onClose={noop} />)
    expect(failed).toContain('Not allowed.')
    expect(failed).toContain('Try again')
  })
})

describe('UnlockGrantPromptView', () => {
  it('names the device, shows its words, and makes no the default', () => {
    const html = renderToStaticMarkup(
      <UnlockGrantPromptView ask={{ id: 'g', name: 'Console on iPad', words: ['able', 'baby', 'cable', 'dance'], askedAt: 0, until: 1 }} busy={false} error={null} onAllow={noop} onDeny={noop} onLater={noop} />
    )
    expect(html).toContain('Let Console on iPad unlock this Mac?')
    expect(html).toContain('able baby cable dance')
    expect(html).toContain('rp-action rp-primary">Don’t allow')
  })
})
