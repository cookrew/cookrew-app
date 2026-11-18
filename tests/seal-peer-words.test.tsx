import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SealPeerWordsView } from '../src/renderer/src/SealPeerWords'
import { SEALED_ONLY_NOTE, SealedOnlyRowView } from '../src/renderer/src/SealedOnlyRow'

const noop = (): void => undefined

describe('another of your computers, met for the first time', () => {
  it('shows the pair\'s six words and the three answers', () => {
    const html = renderToStaticMarkup(
      <SealPeerWordsView peer={{ deviceId: '53ab5b71-1430-891d-a7ce-2e3d6f3856bc', mine: ['able', 'baby', 'cable', 'dance', 'eagle', 'fabric'], theirs: ['gadget', 'habit', 'ice', 'jacket', 'kangaroo', 'label'] }} busy={false} onAnswer={noop} />
    )
    expect(html).toContain('able baby cable dance eagle fabric')
    expect(html).toContain('gadget habit ice jacket kangaroo label')
    expect(html).toContain('The other computer')
    for (const answer of ['SAME WORDS', 'NOT THE SAME', 'LATER']) expect(html).toContain(answer)
    expect(html).toContain('53ab5b71')
  })
})

describe('the sealed-only switch', () => {
  it('says what it shuts out, on and off', () => {
    expect(renderToStaticMarkup(<SealedOnlyRowView on={false} onToggle={noop} />)).toContain('sealed only off')
    const on = renderToStaticMarkup(<SealedOnlyRowView on onToggle={noop} />)
    expect(on).toContain('aria-pressed="true"')
    expect(on).toContain(SEALED_ONLY_NOTE.slice(0, 40))
  })
})
