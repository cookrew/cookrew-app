// A PROMPT'S PICTURES, READ (owner, 2026-11-01). The views ask for a picture
// once it comes into view; the reader finds it — a pasted image block in one
// of the card's own session files, or an image file a prompt names — and
// hands an untrusted caller (the phone) nothing outside what it may see.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPromptImageReader, findRecord, imageRefOf } from '../src/main/prompt-image'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const setup = (): { root: string; session: string; attachments: string; elsewhere: string } => {
  const root = mkdtempSync(path.join(tmpdir(), 'prompt-image-'))
  const attachments = path.join(root, 'attachments')
  mkdirSync(attachments)
  writeFileSync(path.join(attachments, 'shot.png'), PNG)
  const elsewhere = path.join(root, 'private.png')
  writeFileSync(elsewhere, PNG)
  const session = path.join(root, 's1.jsonl')
  const big = 'x'.repeat(5 * 1024 * 1024)
  writeFileSync(
    session,
    [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '[Image #1] look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] } }),
      // A tool result QUOTING the uuid, and a long line, between it and the end.
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: [{ type: 'tool_result', content: `"uuid":"u1" ${big}` }] } }),
      ''
    ].join('\n')
  )
  return { root, session, attachments, elsewhere }
}

describe('findRecord', () => {
  it('finds the record by its own uuid, past a line that only quotes it and across chunk edges', async () => {
    const { session } = setup()
    const record = await findRecord(session, 'u1')
    expect(record?.uuid).toBe('u1')
    expect(await findRecord(session, 'nope')).toBeNull()
  })
})

describe('the prompt image reader', () => {
  it('reads a pasted image out of one of the card’s own session files', async () => {
    const { session, attachments } = setup()
    const reader = createPromptImageReader({ chainFiles: async () => [session], attachmentsDir: attachments })
    const image = await reader.read({ terminalId: 't1', file: session, uuid: 'u1', i: 1 }, { trusted: false })
    expect(image?.mime).toBe('image/png')
    expect(Buffer.from(image!.bytes).equals(PNG)).toBe(true)
  })

  it('never reads a file that is not one of that card’s, nor a block that is not an image', async () => {
    const { session, attachments } = setup()
    const reader = createPromptImageReader({ chainFiles: async () => [], attachmentsDir: attachments })
    expect(await reader.read({ terminalId: 't1', file: session, uuid: 'u1', i: 1 }, { trusted: true })).toBeNull()
    const own = createPromptImageReader({ chainFiles: async () => [session], attachmentsDir: attachments })
    expect(await own.read({ terminalId: 't1', file: session, uuid: 'u1', i: 0 }, { trusted: true })).toBeNull()
  })

  it('a path: the phone reads only the attach store, the desktop any picture', async () => {
    const { attachments, elsewhere } = setup()
    const reader = createPromptImageReader({ chainFiles: async () => [], attachmentsDir: attachments })
    expect((await reader.read({ path: path.join(attachments, 'shot.png') }, { trusted: false }))?.mime).toBe('image/png')
    expect(await reader.read({ path: path.join(attachments, '..', 'private.png') }, { trusted: false })).toBeNull()
    expect((await reader.read({ path: elsewhere }, { trusted: true }))?.mime).toBe('image/png')
    // What the owner read is not handed to the phone from the cache.
    expect(await reader.read({ path: elsewhere }, { trusted: false })).toBeNull()
  })

  it('a path that is not a picture, or is gone, is nothing', async () => {
    const { root, attachments } = setup()
    writeFileSync(path.join(root, 'notes.txt'), 'hi')
    const reader = createPromptImageReader({ chainFiles: async () => [], attachmentsDir: attachments })
    expect(await reader.read({ path: path.join(root, 'notes.txt') }, { trusted: true })).toBeNull()
    expect(await reader.read({ path: path.join(root, 'gone.png') }, { trusted: true })).toBeNull()
  })
})

describe('imageRefOf', () => {
  it('takes a well-formed ref off the wire and nothing else', () => {
    expect(imageRefOf({ path: '/a/b.png' })).toEqual({ path: '/a/b.png' })
    expect(imageRefOf({ path: 'b.png' })).toBeNull()
    expect(imageRefOf({ terminalId: 't', file: '/f.jsonl', uuid: 'u-1', i: 2 })).toEqual({ terminalId: 't', file: '/f.jsonl', uuid: 'u-1', i: 2 })
    expect(imageRefOf({ terminalId: 't', file: '/f.jsonl', uuid: 'u"1', i: 2 })).toBeNull()
    expect(imageRefOf({ terminalId: 't', file: '/f.jsonl', uuid: 'u', i: -1 })).toBeNull()
    expect(imageRefOf(null)).toBeNull()
  })
})
