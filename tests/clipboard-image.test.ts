import { describe, expect, it } from 'vitest'
import {
  imageAttachmentName,
  imageFilesFromClipboardItems
} from '../src/renderer/src/clipboard-image'

interface FakeFile {
  type: string
  name?: string
}

function item(kind: string, type: string, file: FakeFile | null): {
  kind: string
  type: string
  getAsFile: () => FakeFile | null
} {
  return { kind, type, getAsFile: () => file }
}

describe('imageFilesFromClipboardItems', () => {
  it('keeps only image files', () => {
    const png = { type: 'image/png' }
    const items = [
      item('file', 'image/png', png),
      item('string', 'text/plain', null),
      item('file', 'application/pdf', { type: 'application/pdf' })
    ]
    expect(imageFilesFromClipboardItems(items)).toEqual([png])
  })

  it('drops image items whose getAsFile returns null', () => {
    const items = [item('file', 'image/jpeg', null)]
    expect(imageFilesFromClipboardItems(items)).toEqual([])
  })

  it('returns an empty list when nothing is on the clipboard', () => {
    expect(imageFilesFromClipboardItems([])).toEqual([])
  })

  it('keeps multiple images in order', () => {
    const a = { type: 'image/png' }
    const b = { type: 'image/gif' }
    expect(
      imageFilesFromClipboardItems([item('file', 'image/png', a), item('file', 'image/gif', b)])
    ).toEqual([a, b])
  })
})

describe('imageAttachmentName', () => {
  it('maps common mime types to sensible extensions', () => {
    expect(imageAttachmentName('image/png', '20260720-101500')).toBe('pasted-image-20260720-101500.png')
    expect(imageAttachmentName('image/jpeg', 's')).toBe('pasted-image-s.jpg')
    expect(imageAttachmentName('image/gif', 's')).toBe('pasted-image-s.gif')
    expect(imageAttachmentName('image/webp', 's')).toBe('pasted-image-s.webp')
  })

  it('derives an extension from unknown image subtypes', () => {
    expect(imageAttachmentName('image/svg+xml', 's')).toBe('pasted-image-s.svg')
  })

  it('falls back to png when the subtype is unusable', () => {
    expect(imageAttachmentName('image/', 's')).toBe('pasted-image-s.png')
    expect(imageAttachmentName('', 's')).toBe('pasted-image-s.png')
  })
})
