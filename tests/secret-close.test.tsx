// DELETING A NOTE THAT HOLDS SEALED SECRETS (owner 2026-11-05). The value lives
// in the store, not in the note, so removing the card left it readable. The
// close dialog now offers to take the values too: unticked by default, naming
// them, and never a value another note still has a slot for. Values go first,
// so a failure leaves the card, and with it the slot to try again from.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SecretCloseChoice } from '../src/renderer/src/ConfirmClose'
import { closeLabel, noteSecrets, removeSecrets } from '../src/renderer/src/confirm-close'
import type { CanvasNode, NoteNodeData } from '../src/shared/model'

const note = (over: Partial<NoteNodeData> = {}): NoteNodeData => ({
  kind: 'note',
  id: 'n1',
  name: 'keys',
  customName: null,
  content: '🔒 stripe-key\n🔒 openai-key\n🔒 never-sealed\n',
  locked: false,
  position: { x: 0, y: 0 },
  size: { width: 10, height: 10 },
  ...over
})
const SEALED = ['stripe-key', 'openai-key', 'other-one']

describe('what the note holds', () => {
  it('names the sealed slots only, and nothing for a note without any', () => {
    expect(noteSecrets(note(), SEALED, [note()])).toEqual({ remove: ['stripe-key', 'openai-key'], shared: [] })
    expect(noteSecrets(note({ content: 'plain words' }), SEALED, [])).toEqual({ remove: [], shared: [] })
  })

  it('keeps back a value another note still has a slot for, and says which', () => {
    const self = note()
    const other = note({ id: 'n2', name: 'deploy', content: 'text\n🔒 stripe-key\n' })
    const cards: CanvasNode[] = [self, other]
    expect(noteSecrets(self, SEALED, cards)).toEqual({ remove: ['openai-key'], shared: [{ name: 'stripe-key', by: 'deploy' }] })
  })

  it('is nothing for a card that is not a note', () => {
    const browser = { kind: 'browser', id: 'b', name: 'B', url: 'x', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } as CanvasNode
    expect(noteSecrets(browser, SEALED, [])).toEqual({ remove: [], shared: [] })
  })
})

describe('the dialog', () => {
  const noop = (): void => undefined

  it('offers the values unticked, by name', () => {
    const html = renderToStaticMarkup(<SecretCloseChoice plan={{ remove: ['stripe-key', 'openai-key'], shared: [] }} ticked={false} busy={false} onTick={noop} />)
    expect(html).toContain('type="checkbox"')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('stripe-key')
    expect(html).toContain('openai-key')
    expect(html).toContain('stay in the store')
  })

  it('says what ticking does, and names what stays for another note', () => {
    const html = renderToStaticMarkup(<SecretCloseChoice plan={{ remove: ['a-key'], shared: [{ name: 'b-key', by: 'deploy' }] }} ticked busy={false} onTick={noop} />)
    expect(html).toContain('checked=""')
    expect(html).toContain('Agents can no longer read')
    expect(html).toContain('b-key')
    expect(html).toContain('deploy')
  })

  it('draws no box when there is nothing to take, and still names a kept value', () => {
    expect(renderToStaticMarkup(<SecretCloseChoice plan={{ remove: [], shared: [] }} ticked={false} busy={false} onTick={noop} />)).toBe('')
    const html = renderToStaticMarkup(<SecretCloseChoice plan={{ remove: [], shared: [{ name: 'b-key', by: 'deploy' }] }} ticked={false} busy={false} onTick={noop} />)
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain('b-key')
  })

  it('names the button for what it will do', () => {
    expect(closeLabel('Delete note', 0)).toBe('Delete note')
    expect(closeLabel('Delete note', 1)).toBe('Delete note and 1 value')
    expect(closeLabel('Delete note', 3)).toBe('Delete note and 3 values')
  })
})

describe('taking the values', () => {
  it('takes each in turn', async () => {
    const gone: string[] = []
    const done = await removeSecrets(['a', 'b'], async (name) => (gone.push(name), true))
    expect(done).toEqual({ ok: true })
    expect(gone).toEqual(['a', 'b'])
  })

  it('stops at a failure and says which, so the card can stay', async () => {
    const gone: string[] = []
    const done = await removeSecrets(['a', 'b', 'c'], async (name) => {
      if (name === 'b') throw new Error('keychain locked')
      gone.push(name)
      return true
    })
    expect(done).toEqual({ ok: false, error: 'b could not be deleted: keychain locked' })
    expect(gone).toEqual(['a'])
  })
})
