import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WatchSealWordsView, type PendingWatchKey } from '../src/renderer/src/WatchSealWords'

const row: PendingWatchKey = { deviceId: '0f0e0d0c-0b0a-4908-8706-050403020100', x: 'k', words: ['able', 'baby', 'cable', 'dance', 'eagle', 'fabric'] }
const noop = (): void => undefined

describe('the watch\'s six words on the Mac', () => {
  it('shows nothing when no watch waits', () => {
    expect(renderToStaticMarkup(<WatchSealWordsView pending={[]} busy={false} onSame={noop} onNotSame={noop} />)).toBe('')
  })

  it('shows the six words and both answers for a watch that waits', () => {
    const html = renderToStaticMarkup(<WatchSealWordsView pending={[row]} busy={false} onSame={noop} onNotSame={noop} />)
    expect(html).toContain('able baby cable dance eagle fabric')
    expect(html).toContain('SAME WORDS ON THE WATCH')
    expect(html).toContain('NOT THE SAME')
  })

  it('says so when the watch\'s key changed under a confirm', () => {
    const html = renderToStaticMarkup(<WatchSealWordsView pending={[]} busy={false} note="The watch’s key changed since these words. Compare the new words." onSame={noop} onNotSame={noop} />)
    expect(html).toContain('key changed')
  })
})
