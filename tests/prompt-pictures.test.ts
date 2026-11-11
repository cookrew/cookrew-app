// A PROMPT'S PICTURES, DRAWN (owner, 2026-11-01): the screenshots of a turn
// in CHAT and LOG, and of a draft in the prompt box, read lazily and once.

import { describe, expect, it, vi } from 'vitest'
import { createPictureCache } from '../src/renderer/src/pictures/picture-cache'
import { picturesOfDraft, picturesOfTurn } from '../src/renderer/src/pictures/PictureStrip'

const SHOT = '/Users/me/.cookrew/attachments/pasted-image-1.png'
const BYTES = { mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }

const urls = (): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } => {
  let n = 0
  return { create: vi.fn(() => `blob:${(n += 1)}`), revoke: vi.fn() }
}

describe('the picture cache', () => {
  it('reads a picture once, however often it is shown', async () => {
    const read = vi.fn(async () => BYTES)
    const cache = createPictureCache(read, urls())
    expect(await cache.load({ path: SHOT })).toBe('blob:1')
    expect(await cache.load({ path: SHOT })).toBe('blob:1')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('a picture that is not there is nothing to draw, and a failed read is not a crash', async () => {
    const cache = createPictureCache(async (ref) => {
      if ('path' in ref && ref.path === '/gone.png') return null
      throw new Error('link down')
    }, urls())
    expect(await cache.load({ path: '/gone.png' })).toBeNull()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await cache.load({ path: '/x.png' })).toBeNull()
  })

  it('past the bound the least recently shown is let go, and its URL revoked', async () => {
    const u = urls()
    const read = vi.fn(async () => BYTES)
    const cache = createPictureCache(read, u, 2)
    await cache.load({ path: '/a.png' })
    await cache.load({ path: '/b.png' })
    await cache.load({ path: '/a.png' })
    await cache.load({ path: '/c.png' })
    await Promise.resolve()
    expect(u.revoke).toHaveBeenCalledWith('blob:2')
    await cache.load({ path: '/a.png' })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('cleared, every picture is let go and its URL given back: they were another machine’s', async () => {
    const u = urls()
    const read = vi.fn(async () => BYTES)
    const cache = createPictureCache(read, u)
    await cache.load({ path: '/a.png' })
    await cache.load({ path: '/b.png' })
    cache.clear()
    await Promise.resolve()
    expect(u.revoke.mock.calls.map(([url]) => url).sort()).toEqual(['blob:1', 'blob:2'])
    // The same path is read again: on the next machine it names another file, or none.
    await cache.load({ path: '/a.png' })
    expect(read).toHaveBeenCalledTimes(3)
  })
})

describe('which pictures a turn and a draft carry', () => {
  it('a turn: Claude’s own pastes from its session file, then the screenshots it names', () => {
    const pictures = picturesOfTurn(
      { prompt: `[Image #2] and ${SHOT}`, images: [{ uuid: 'u1', i: 1, n: 2 }], file: '/s/a.jsonl' },
      't1'
    )
    expect(pictures.map((p) => p.pasted === true)).toEqual([true, false])
    expect(pictures.map((p) => [p.label, p.ref])).toEqual([
      ['Image #2', { terminalId: 't1', file: '/s/a.jsonl', uuid: 'u1', i: 1 }],
      ['pasted-image-1.png', { path: SHOT }]
    ])
  })

  it('a pasted image with no file to read it from (a door card) is not drawn; its words still are', () => {
    expect(picturesOfTurn({ prompt: '[Image #1] hi', images: [{ uuid: 'u1', i: 1, n: 1 }] }, 't1')).toEqual([])
  })

  it('a draft: the screenshots it names, by path', () => {
    expect(picturesOfDraft(`look ${SHOT} `).map((p) => p.path)).toEqual([SHOT])
    expect(picturesOfDraft('plain words')).toEqual([])
  })
})
