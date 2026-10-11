// THE SLOT: a chip on the face, a password field in the editor, and a body
// that is never more than `🔒 <name>`.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SecretSlot, SECRET_SLOT_COPY, sealedWhen } from '../src/renderer/src/nodes/SecretSlot'
import { renderNoteMarkdown } from '../src/renderer/src/note-markdown'
import { isSecretName, secretSlotLine, secretSlotOf, secretSlotsOf } from '../src/shared/secret-slot'

const VALUE = 'sk_live_51Hx9QxTESTVALUE0000'

describe('the slot grammar', () => {
  it('a slot is exactly one line, `🔒 <name>`, and names are slot names', () => {
    expect(secretSlotLine('stripe-key')).toBe('🔒 stripe-key')
    expect(secretSlotOf('🔒 stripe-key')).toBe('stripe-key')
    expect(secretSlotOf('🔒 stripe-key  ')).toBe('stripe-key')
    expect(secretSlotOf('🔒 Stripe Key')).toBeNull()
    expect(secretSlotOf('see 🔒 stripe-key')).toBeNull()
    expect(secretSlotOf('🔒stripe-key')).toBeNull()
    expect(isSecretName('a'.repeat(64))).toBe(true)
    expect(isSecretName('a'.repeat(65))).toBe(false)
    expect(isSecretName('-a')).toBe(false)
  })
  it('a body lists its slots once each, in order', () => {
    expect(secretSlotsOf('# Keys\n🔒 stripe-key\ntext\n🔒 openai-key\n🔒 stripe-key\n')).toEqual(['stripe-key', 'openai-key'])
    expect(secretSlotsOf('no slots here')).toEqual([])
  })
})

describe('the card face', () => {
  it('draws a slot as a chip with its name, and never a field', () => {
    const html = renderNoteMarkdown('# Stripe keys\n\nThe live key goes in a sealed slot.\n\n🔒 stripe-key\n')
    expect(html).toContain('<span class="cr-secret-chip" data-secret-chip="stripe-key">🔒 stripe-key</span>')
    expect(html).not.toContain('<input')
    expect(html).toContain('<h1')
  })
  it('a lock in running text is text, not a chip', () => {
    const html = renderNoteMarkdown('use 🔒 stripe-key here')
    expect(html).not.toContain('cr-secret-chip')
    expect(html).toContain('🔒 stripe-key')
  })
  it('a chip never carries markup from the name', () => {
    expect(renderNoteMarkdown('🔒 <b>x</b>')).not.toContain('cr-secret-chip')
  })
})

describe('the editor block', () => {
  const put = async (name: string, _value: string, served: boolean) => ({ name, served, updatedAt: 1_760_000_000_000 })

  it('is the DOM hook the inbox lands on, with a focusable password field', () => {
    const html = renderToStaticMarkup(<SecretSlot name="stripe-key" entry={null} put={put} />)
    expect(html).toContain('data-secret-slot="stripe-key"')
    expect(html).toContain('type="password"')
    expect(html).toContain('aria-label="SECRET stripe-key"')
    expect(html).toContain('🔒 stripe-key')
  })

  it('says "not set" with nothing sealed, and "set ✓ · updated <when>" with the field EMPTY once it is', () => {
    const empty = renderToStaticMarkup(<SecretSlot name="stripe-key" entry={null} put={put} />)
    expect(empty).toContain(SECRET_SLOT_COPY.empty)
    const now = Date.now()
    const set = renderToStaticMarkup(
      <SecretSlot name="stripe-key" entry={{ name: 'stripe-key', served: false, updatedAt: now }} put={put} />
    )
    expect(set).toContain(`${SECRET_SLOT_COPY.set} · ${sealedWhen(now)} · served ✗`)
    expect(set).toContain('value=""')
    expect(set).not.toContain(VALUE)
  })

  it('the served toggle is off by default, and follows the store when it holds a flag', () => {
    const fresh = renderToStaticMarkup(<SecretSlot name="k" entry={null} put={put} />)
    expect(fresh).toContain(`${SECRET_SLOT_COPY.served} — ${SECRET_SLOT_COPY.off}`)
    expect(fresh).not.toContain('checked=""')
    const served = renderToStaticMarkup(<SecretSlot name="k" entry={{ name: 'k', served: true, updatedAt: 1 }} put={put} />)
    expect(served).toContain('checked=""')
  })

  it('SEAL is the only way out of the field, and the body is not on its path', () => {
    const src = readFileSync('src/renderer/src/nodes/SecretSlot.tsx', 'utf8')
    expect(src).toContain('put(name, value, served)')
    expect(src).not.toContain('updateNode')
    expect(src).not.toContain('content')
    const node = readFileSync('src/renderer/src/nodes/NoteNode.tsx', 'utf8')
    // The seal updates the listing map and nothing else; the draft is untouched.
    const seal = node.slice(node.indexOf('onSealed={'), node.indexOf('onSealed={') + 120)
    expect(seal).toContain('setSealed(')
    expect(seal).not.toContain('setDraft')
  })

  it('exists on the zoomed card in BOTH states, so the inbox can focus it without a double-click', () => {
    const node = readFileSync('src/renderer/src/nodes/NoteNode.tsx', 'utf8')
    expect(node).toContain("secretSlotsOf(editing ? draft : node.content)")
    // Rendered after the editing/viewing branch, not inside it.
    expect(node.indexOf('{hasSlots && (')).toBeGreaterThan(node.indexOf('__html: renderNoteMarkdown'))
  })
})
