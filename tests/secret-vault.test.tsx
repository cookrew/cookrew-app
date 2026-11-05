// THE SECRET NOTE IS A NOTE WITH A VAULT IN IT (owner 2026-11-05): "like a note
// you can edit, a vault table inside". The words read as a note, the slots as
// one table under them, and a delete is not in the body at all: it is the
// note's close dialog (tests/secret-close.test.tsx).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { VaultRow, VaultTable } from '../src/renderer/src/nodes/SecretVault'
import { SECRET_SLOT_COPY } from '../src/renderer/src/nodes/SecretSlot'
import { closePrompt } from '../src/renderer/src/confirm-close'
import { vaultAdd, withSlotLine, withWords, withoutSlotLines } from '../src/shared/secret-slot'
import type { NoteNodeData } from '../src/shared/model'

const entry = { name: 'stripe-key', served: false, updatedAt: Date.now() }
const put = async (name: string, _value: string, served: boolean) => ({ name, served, updatedAt: 1 })
const noop = (): void => undefined

describe('the body', () => {
  it('keeps its words and leaves the slots to the table', () => {
    expect(withoutSlotLines('# Keys\n\nFor deploys.\n\n🔒 stripe-key\n🔒 openai-key\n')).toBe('# Keys\n\nFor deploys.')
    expect(withoutSlotLines('🔒 stripe-key\n')).toBe('')
    expect(withoutSlotLines('see 🔒 stripe-key here')).toBe('see 🔒 stripe-key here')
  })

  it('takes a new slot on a line of its own', () => {
    expect(withSlotLine('', 'a-key')).toBe('🔒 a-key\n')
    expect(withSlotLine('🔒 b-key\n', 'a-key')).toBe('🔒 b-key\n🔒 a-key\n')
    expect(withSlotLine('words', 'a-key')).toBe('words\n🔒 a-key\n')
  })
})

// QA 2026-11-05: the editor opened with its caret before the first slot line,
// and words typed there ran into it: `words🔒 name` is no slot, so the row went
// and the close dialog no longer offered that value. A secret note's editor now
// holds its words alone; the slot lines are the table's.
describe('editing a secret note', () => {
  it('puts the words back above the slots, whatever was typed', () => {
    expect(withWords('🔒 a-key\n🔒 b-key\n', 'Staging keys.')).toBe('Staging keys.\n\n🔒 a-key\n🔒 b-key\n')
    expect(withWords('Old words\n\n🔒 a-key\n', 'New words')).toBe('New words\n\n🔒 a-key\n')
    expect(withWords('Old words\n\n🔒 a-key\n', '')).toBe('🔒 a-key\n')
  })

  it('keeps every slot of a body that had them among its words', () => {
    expect(withWords('# Keys\n🔒 a-key\nmiddle\n🔒 b-key\nend\n', '# Keys\nmiddle\nend')).toBe('# Keys\nmiddle\nend\n\n🔒 a-key\n🔒 b-key\n')
  })

  it('takes a slot line typed into the words as a slot, once', () => {
    expect(withWords('🔒 a-key\n', 'words\n🔒 a-key\n🔒 b-key')).toBe('words\n\n🔒 a-key\n🔒 b-key\n')
  })

  it('round-trips a body it did not change', () => {
    const body = 'Staging keys.\n\n🔒 a-key\n'
    expect(withWords(body, withoutSlotLines(body))).toBe(body)
  })

  it('is what the note view saves', () => {
    const panel = readFileSync('src/renderer/src/AttachPanel.tsx', 'utf8')
    expect(panel).toContain('withWords(note.content, draft)')
  })
})

describe('a row', () => {
  const row = (e: typeof entry | null): string => renderToStaticMarkup(<VaultRow name="stripe-key" entry={e} put={put} />)

  it('is the hook the inbox lands on, with its field first', () => {
    const html = row(null)
    expect(html).toContain('data-secret-slot="stripe-key"')
    expect(html).toContain('type="password"')
    expect(html).toContain('aria-label="SECRET stripe-key"')
    expect(html).toContain(SECRET_SLOT_COPY.empty)
  })

  it('shows a sealed value as sealed, the field empty and no dots', () => {
    const html = row(entry)
    expect(html).toContain('value=""')
    expect(html).toContain('placeholder="sealed · paste to replace"')
    expect(html).toContain(SECRET_SLOT_COPY.set)
    expect(html).not.toContain('••••')
  })

  it('stays one line at rest: SEAL and the served box wait for a value', () => {
    const html = row(entry)
    expect(html).not.toContain(SECRET_SLOT_COPY.seal)
    expect(html).not.toContain(SECRET_SLOT_COPY.served)
  })
})

describe('the table', () => {
  const table = (canAdd: boolean): string =>
    renderToStaticMarkup(<VaultTable names={['stripe-key', 'openai-key']} sealed={new Map([['stripe-key', entry]])} canAdd={canAdd} put={put} onSealed={noop} onAddSlot={async () => undefined} />)

  it('has one head, a row per slot, and says how agents read it once', () => {
    const html = table(true)
    expect(html.match(/role="columnheader"/g)).toHaveLength(3)
    expect(html.match(/data-secret-slot=/g)).toHaveLength(2)
    expect(html.split('cookrew secret exec')).toHaveLength(2)
  })

  it('offers a new row, unless the note may not be written', () => {
    expect(table(true)).toContain('add secret')
    expect(table(false)).not.toContain('add secret')
  })

  it('has no delete in it, here or in the old slot block', () => {
    expect(table(true).toLowerCase()).not.toContain('delete')
    expect(readFileSync('src/renderer/src/nodes/SecretVault.tsx', 'utf8')).not.toContain('secretRemove')
    expect(readFileSync('src/renderer/src/nodes/SecretSlot.tsx', 'utf8')).not.toContain('secretRemove')
  })
})

describe('adding a row', () => {
  const at = (raw: string, value = '', sealed: string[] = [], held: string[] = []) => vaultAdd({ raw, value, sealed, held })

  it('spells the name and says how agents read it', () => {
    expect(at('DeepSeek key', 'v')).toEqual({ name: 'deepseek-key', ok: true, hint: 'agents read it as deepseek-key' })
    expect(at('DeepSeek key').hint).toContain('fill it in later')
    expect(at('DeepSeek key').ok).toBe(true)
  })

  it('refuses a name nothing of which can be typed, and one already in this note', () => {
    expect(at('---')).toMatchObject({ name: null, ok: false })
    expect(at('a-key', '', [], ['a-key'])).toMatchObject({ ok: false, hint: 'a-key is already in this note' })
  })

  it('never overwrites a sealed value: with the name sealed, it may only be used', () => {
    expect(at('a-key', 'new', ['a-key'])).toMatchObject({ ok: false })
    expect(at('a-key', '', ['a-key'])).toMatchObject({ name: 'a-key', ok: true, hint: 'uses the sealed a-key' })
  })
})

// QA 2026-11-05: a name sealed after the table opened was still offered as new,
// because the check read the table's own listing.
describe('the store is asked again', () => {
  it('when the row opens, and at the moment of the act, before any put', () => {
    const src = readFileSync('src/renderer/src/nodes/SecretVault.tsx', 'utf8')
    expect(src).toContain('sealed: await reread()')
    expect(src.indexOf('sealed: await reread()')).toBeLessThan(src.indexOf('await put(plan.name'))
    expect(src).toContain('void reread().catch')
  })
})

describe('the delete dialog', () => {
  const note = (content: string): NoteNodeData => ({ kind: 'note', id: 'n', name: 'keys', customName: null, content, locked: false, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } })

  it('calls a note with slots a secret note, by its name', () => {
    const p = closePrompt(note('🔒 stripe-key\n'))
    expect(p.title).toBe('Delete this secret note?')
    expect(p.subject).toBe('keys')
    expect(p.confirmLabel).toBe('Delete note')
    expect(p.danger).toBe(true)
    expect(closePrompt(note('plain')).title).toBe('Delete this note?')
  })
})

describe('the open note', () => {
  it('draws the vault under its words, in one scroll', () => {
    const panel = readFileSync('src/renderer/src/AttachPanel.tsx', 'utf8')
    expect(panel).toContain('<SecretVault')
    expect(panel).toContain('attach-note-scroll')
    expect(panel).toContain('withoutSlotLines(note.content)')
  })

  it('has a way into its words when the table leaves nowhere to double-click', () => {
    const panel = readFileSync('src/renderer/src/AttachPanel.tsx', 'utf8')
    expect(panel).toContain('attach-note-addwords')
    expect(panel).toContain('Write about these secrets…')
  })
})
