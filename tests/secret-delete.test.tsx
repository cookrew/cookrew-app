// DELETING A SEALED SECRET (owner 2026-11-05). The store, the IPC and the
// phone's owner route could always forget a value; nothing on screen asked
// them to. A sealed slot now offers DELETE, asks once, and goes back to
// "not set". The note keeps its `🔒 <name>` line, so the slot can be sealed
// again, and a slot with nothing sealed offers nothing to delete.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SECRET_SLOT_COPY, SecretRemove, SecretSlot } from '../src/renderer/src/nodes/SecretSlot'
import { afterRemove } from '../src/shared/secret-slot'

const put = async (name: string, _value: string, served: boolean) => ({ name, served, updatedAt: 1 })
const entry = { name: 'stripe-key', served: false, updatedAt: 1_760_000_000_000 }
const noop = (): void => undefined

describe('the slot', () => {
  it('offers DELETE once something is sealed, and never before', () => {
    expect(renderToStaticMarkup(<SecretSlot name="stripe-key" entry={entry} put={put} />)).toContain(`aria-label="${SECRET_SLOT_COPY.remove} stripe-key"`)
    expect(renderToStaticMarkup(<SecretSlot name="stripe-key" entry={null} put={put} />)).not.toContain('cr-secret-slot-remove')
  })
})

describe('the ask', () => {
  const ask = (asking: boolean, busy = false): string =>
    renderToStaticMarkup(<SecretRemove name="stripe-key" asking={asking} busy={busy} onAsk={noop} onKeep={noop} onConfirm={noop} />)

  it('is one quiet button at rest: the first click deletes nothing', () => {
    const html = ask(false)
    expect(html).not.toContain(SECRET_SLOT_COPY.removeAsk)
    expect(html).not.toContain('danger')
  })

  it('says what goes and what stays, with a way back', () => {
    const html = ask(true)
    expect(html).toContain(SECRET_SLOT_COPY.removeAsk)
    expect(html).toContain('danger')
    expect(html).toContain(SECRET_SLOT_COPY.keep)
    expect(SECRET_SLOT_COPY.removeAsk).toContain('the note keeps its slot')
  })

  it('holds both buttons while the store answers', () => {
    const html = ask(true, true)
    expect(html).toContain(SECRET_SLOT_COPY.removing)
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
})

describe('after the store forgets it', () => {
  it('drops this name from the listing, and leaves the old map and the other names alone', () => {
    const before = new Map([
      ['openai-key', { name: 'openai-key', served: false, updatedAt: 1 }],
      ['stripe-key', { name: 'stripe-key', served: true, updatedAt: 2 }]
    ])
    const next = afterRemove('stripe-key', before)
    expect([...next.keys()]).toEqual(['openai-key'])
    expect(before.has('stripe-key')).toBe(true)
  })

  it('the block listens, and the delete never touches the note', () => {
    const src = readFileSync('src/renderer/src/nodes/SecretSlot.tsx', 'utf8')
    expect(src).toContain('afterRemove(gone, prev)')
    expect(src).not.toContain('updateNode')
    expect(src).not.toContain('content')
  })
})
