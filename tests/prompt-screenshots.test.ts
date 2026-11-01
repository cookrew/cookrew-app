// SCREENSHOTS IN THE PROMPT BOX (owner, 2026-11-01: screenshots work in the
// prompt input box). A screenshot pasted (⌘V) or a file dropped on the global prompt,
// or on a card's reply box, is saved the way the terminal saves one, and its
// absolute path goes into the draft at the caret: the draft is the agent's
// own input line, so the agent reads the file itself, and a new agent's
// first prompt carries it the same way.

import { describe, expect, it, vi } from 'vitest'
import { saveClipboardImages } from '../src/renderer/src/clipboard-image'
import { insertAttached, pastedImages, withPaths } from '../src/renderer/src/prompt/prompt-attach'
import { isTemporaryDrop, pathsForFiles } from '../src/renderer/src/dropped-files'

const SHOT = '/Users/me/.cookrew/attachments/pasted-image-1.png'

describe('withPaths', () => {
  it('puts the path at the caret, set apart by spaces, the caret after it', () => {
    expect(withPaths('look at  please', { start: 8, end: 8 }, [SHOT])).toEqual({
      text: `look at ${SHOT} please`,
      caret: 8 + SHOT.length
    })
    expect(withPaths('look at', { start: 7, end: 7 }, [SHOT])).toEqual({ text: `look at ${SHOT} `, caret: 8 + SHOT.length + 1 })
  })

  it('an empty box takes the path and a space to type on after', () => {
    expect(withPaths('', null, [SHOT])).toEqual({ text: `${SHOT} `, caret: SHOT.length + 1 })
  })

  it('no caret known: the path goes at the end', () => {
    expect(withPaths('fix this', null, [SHOT]).text).toBe(`fix this ${SHOT} `)
  })

  it('a selection is replaced by the path', () => {
    expect(withPaths('see HERE now', { start: 4, end: 8 }, [SHOT]).text).toBe(`see ${SHOT} now`)
  })

  it('several paths go in one after another; a space in one is escaped', () => {
    expect(withPaths('', null, ['/tmp/a.png', '/tmp/My Shot.png']).text).toBe('/tmp/a.png /tmp/My\\ Shot.png ')
  })

  it('nothing to put in leaves the draft alone', () => {
    expect(withPaths('words', { start: 2, end: 2 }, [])).toEqual({ text: 'words', caret: 2 })
    expect(withPaths('words', null, [''])).toEqual({ text: 'words', caret: 5 })
  })
})

describe('insertAttached', () => {
  it('the caret of the paste holds while the draft is unchanged', () => {
    expect(insertAttached('ab', 'ab', { start: 1, end: 1 }, ['/p']).text).toBe('a /p b')
  })

  it('words typed while the screenshot saved: the path goes at the end, the words stay', () => {
    expect(insertAttached('ab', 'abc', { start: 1, end: 1 }, ['/p']).text).toBe('abc /p ')
  })
})

describe('pastedImages', () => {
  const item = (kind: string, type: string) => ({ kind, type, getAsFile: () => ({ type }) })
  it('takes the image items of a paste, nothing else', () => {
    const data = { items: [item('string', 'text/plain'), item('file', 'image/png'), item('file', 'application/pdf')] }
    expect(pastedImages(data)).toEqual([{ type: 'image/png' }])
  })

  it('a text paste, or none, has no images (the box pastes the text itself)', () => {
    expect(pastedImages({ items: [item('string', 'text/plain')] })).toEqual([])
    expect(pastedImages(null)).toEqual([])
  })
})

describe('pathsForFiles', () => {
  const file = (name: string, type = 'image/png') => ({ name, type, arrayBuffer: () => Promise.resolve(new ArrayBuffer(3)) })

  it("a dropped file is read where it lies (the attach store's path for it)", async () => {
    const api = { attachFiles: vi.fn(async () => ['/Users/me/Desktop/Shot.png']), saveAttachmentBytes: vi.fn() }
    expect(await pathsForFiles([file('Shot.png')], api)).toEqual(['/Users/me/Desktop/Shot.png'])
    expect(api.saveAttachmentBytes).not.toHaveBeenCalled()
  })

  it('a file with no path of its own (a screenshot dragged from its thumbnail) is saved from its bytes', async () => {
    const api = {
      attachFiles: vi.fn(async () => ['/tmp/a.png', '']),
      saveAttachmentBytes: vi.fn(async (name: string) => `/Users/me/.cookrew/attachments/${name}`)
    }
    expect(await pathsForFiles([file('a.png'), file('Screenshot 1.png')], api)).toEqual([
      '/tmp/a.png',
      '/Users/me/.cookrew/attachments/Screenshot 1.png'
    ])
  })
})

describe('a screenshot dragged from its floating thumbnail', () => {
  // macOS hands the drag a file in TemporaryItems and deletes it once the drag
  // is over (owner, 2026-11-01: the path that reached the agent was already
  // gone). The bytes are read at the drop and kept in the attach store.
  const TEMP = '/var/folders/7t/x/T/TemporaryItems/NSIRD_screencaptureui_LiGsXW/Screenshot 2026-11-01 at 8.07.47 PM.png'
  const file = (name: string) => ({ name, type: 'image/png', arrayBuffer: vi.fn(() => Promise.resolve(new Uint8Array([9]).buffer)) })

  it('knows a path the system takes away from one that stays', () => {
    expect(isTemporaryDrop(TEMP)).toBe(true)
    expect(isTemporaryDrop('/Users/me/Desktop/Screenshot 2026-11-01 at 8.07.47 PM.png')).toBe(false)
    expect(isTemporaryDrop('/Users/me/.cookrew/attachments/a.png')).toBe(false)
  })

  it('is saved from its bytes, never handed on as the temporary path', async () => {
    const shot = file('Screenshot 2026-11-01 at 8.07.47 PM.png')
    const api = {
      attachFiles: vi.fn(async () => [TEMP]),
      saveAttachmentBytes: vi.fn(async (name: string) => `/Users/me/.cookrew/attachments/${name}`)
    }
    expect(await pathsForFiles([shot], api)).toEqual(['/Users/me/.cookrew/attachments/Screenshot 2026-11-01 at 8.07.47 PM.png'])
    expect(api.saveAttachmentBytes.mock.calls[0][1]).toEqual(new Uint8Array([9]))
  })

  it('a file that stays where it lies is not read at all', async () => {
    const kept = file('big.mov')
    const api = { attachFiles: vi.fn(async () => ['/Users/me/Movies/big.mov']), saveAttachmentBytes: vi.fn() }
    expect(await pathsForFiles([kept], api)).toEqual(['/Users/me/Movies/big.mov'])
    expect(kept.arrayBuffer).not.toHaveBeenCalled()
  })
})

describe('saveClipboardImages', () => {
  it('names each pasted image by its type and the moment, in order', async () => {
    const image = (type: string) => ({ type, arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2]).buffer) })
    const saveAttachmentBytes = vi.fn(async (name: string) => `/a/${name}`)
    expect(await saveClipboardImages([image('image/png')], { saveAttachmentBytes }, '7')).toEqual(['/a/pasted-image-7.png'])
    expect(await saveClipboardImages([image('image/png'), image('image/jpeg')], { saveAttachmentBytes }, '7')).toEqual([
      '/a/pasted-image-7-1.png',
      '/a/pasted-image-7-2.jpg'
    ])
    expect(saveAttachmentBytes.mock.calls[0][1]).toEqual(new Uint8Array([1, 2]))
  })
})
