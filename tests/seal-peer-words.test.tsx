import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { answerFailed, BLOCKED_PARTLY, SealPeerFailedView, SealPeerSheet, SealPeerWordsView } from '../src/renderer/src/SealPeerWords'
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

describe('a NOT THE SAME that could not be written whole (Relay round 4, F2)', () => {
  it('is told to the owner, never closed silently', () => {
    expect(answerFailed('not-same', false)).toBe(true)
    expect(answerFailed('not-same', undefined)).toBe(true)
    expect(answerFailed('not-same', true)).toBe(false)
    // Same and Later have no partial outcome to tell.
    expect(answerFailed('same', false)).toBe(false)
    expect(answerFailed('later', false)).toBe(false)
    const html = renderToStaticMarkup(<SealPeerFailedView onDismiss={noop} />)
    expect(html).toContain('Blocked only in part')
    expect(html).toContain(BLOCKED_PARTLY.slice(0, 40))
    expect(html).toContain('role="alertdialog"')
  })

  it('the failure shows first, even once the computer no longer waits; then the words; nothing when neither', () => {
    const peer = { deviceId: '53ab5b71-1430-891d-a7ce-2e3d6f3856bc', mine: ['able'], theirs: ['gadget'] }
    const sheet = (over: { peer?: typeof peer; failed: boolean }) => renderToStaticMarkup(<SealPeerSheet peer={over.peer} failed={over.failed} busy={false} onAnswer={noop} onDismiss={noop} />)
    expect(sheet({ peer: undefined, failed: true })).toContain('Blocked only in part')
    expect(sheet({ peer, failed: true })).toContain('Blocked only in part')
    expect(sheet({ peer, failed: true })).not.toContain('SAME WORDS')
    expect(sheet({ peer, failed: false })).toContain('SAME WORDS')
    expect(sheet({ peer: undefined, failed: false })).toBe('')
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
