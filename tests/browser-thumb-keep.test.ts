// THE LAST PICTURE OF A BROWSER OUTLIVES ITS PAGE (owner 2026-11-16: every workspace
// tile's front page was a drawing on all three ends, because the cache held only what
// a running page gave it, in memory). The keep writes each new frame and the cache
// reads it back when it holds none; a tile's front page is never cut by a long deck.
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserThumbCache } from '../src/main/browser-thumb-cache'
import { browserThumbKeep } from '../src/main/browser-thumb-keep'
import { thumbWants, THUMB_WANTS_MAX } from '../src/renderer/src/pets/thumb-wants'

const b64 = (text: string): string => Buffer.from(text).toString('base64')
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

describe('the kept browser picture', () => {
  it('survives the cache: a new app reads the last frame back, with no page running', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thumb-keep-'))
    const before = new BrowserThumbCache({ keep: browserThumbKeep(dir) })
    before.put('b1', b64('page'), 'image/jpeg')
    await settle()
    const after = new BrowserThumbCache({ keep: browserThumbKeep(dir), capture: async () => null })
    expect(after.frame('b1')?.data.toString()).toBe('page')
    expect(after.dataUrl('b1')).toBe(`data:image/jpeg;base64,${b64('page')}`)
  })

  it('is old to the freshness window, so a running page is asked for a newer one at once', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thumb-keep-'))
    new BrowserThumbCache({ keep: browserThumbKeep(dir) }).put('b1', b64('old'), 'image/jpeg')
    await settle()
    let asked = 0
    const cache = new BrowserThumbCache({ keep: browserThumbKeep(dir), capture: async () => { asked += 1; return b64('new') } })
    expect(cache.frame('b1')?.data.toString()).toBe('old')
    await cache.refresh('b1')
    expect(asked).toBe(1)
    expect(cache.frame('b1')?.data.toString()).toBe('new')
  })

  it('writes only when the pixels change, and goes with a forgotten card', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thumb-keep-'))
    const saved: string[] = []
    const keep = browserThumbKeep(dir)
    const cache = new BrowserThumbCache({ keep: { ...keep, save: (id, data, type) => { saved.push(data.toString()); keep.save(id, data, type) } } })
    cache.put('b1', b64('a'), 'image/jpeg')
    cache.put('b1', b64('a'), 'image/jpeg')
    cache.put('b1', b64('b'), 'image/jpeg')
    expect(saved).toEqual(['a', 'b'])
    await settle()
    expect(readdirSync(dir)).toEqual(['b1.jpg'])
    cache.forget('b1')
    await settle()
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps no file for an id that is not a plain card id', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thumb-keep-'))
    browserThumbKeep(dir).save('../escape', Buffer.from('x'), 'image/jpeg')
    await settle()
    expect(readdirSync(dir)).toEqual([])
    expect(browserThumbKeep(dir).load('../escape')).toBeNull()
  })
})

describe("a workspace tile's front page", () => {
  it('is wanted ahead of a long deck, which used to take every place', () => {
    thumbWants.claim('zoom', Array.from({ length: 40 }, (_, i) => `deck${i}`))
    for (const ws of ['w1', 'w2', 'w3']) thumbWants.claim(`tile:${ws}`, [`front-${ws}`])
    const ids = thumbWants.ids()
    expect(ids.slice(0, 3)).toEqual(['front-w1', 'front-w2', 'front-w3'])
    expect(ids).toHaveLength(THUMB_WANTS_MAX)
    for (const owner of ['zoom', 'tile:w1', 'tile:w2', 'tile:w3']) thumbWants.release(owner)
  })
})
