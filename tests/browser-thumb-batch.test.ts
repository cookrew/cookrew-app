import { describe, expect, it } from 'vitest'
import { batchFrames, parseBatchIds, parseKnownVersions, scopedBrowserIds, scopedThumbLookup, THUMB_BATCH_MAX } from '../src/main/browser-thumb-batch'
import {
  applyThumbBatch,
  knownVersions,
  viewportBrowserIds
} from '../src/renderer/src/browser-thumb-policy'

/**
 * The thumb batch (perf lane L7): the phone asks for the browser cards it can
 * see, in one exchange, with the version of each frame it already holds; the
 * companion answers bytes only for what changed.
 */

describe('the companion half — batchFrames', () => {
  const frames = new Map([
    ['a', { data: Buffer.from('AAA'), type: 'image/jpeg', at: 100 }],
    ['b', { data: Buffer.from('BBB'), type: 'image/png', at: 200 }]
  ])
  const lookup = (id: string) => frames.get(id)

  it('answers bytes for a changed frame, a version alone for an unchanged one, null for none', () => {
    expect(batchFrames(['a', 'b', 'c'], { a: 100 }, lookup)).toEqual([
      { id: 'a', at: 100 },
      { id: 'b', at: 200, type: 'image/png', data: Buffer.from('BBB').toString('base64') },
      { id: 'c', at: null }
    ])
  })

  it('a stale version gets the bytes again', () => {
    expect(batchFrames(['a'], { a: 99 }, lookup)[0]).toMatchObject({ id: 'a', at: 100, type: 'image/jpeg' })
  })

  it('parses known versions and skips junk', () => {
    expect(parseKnownVersions('a:100,b:x,:5,c,d:7')).toEqual({ a: 100, d: 7 })
    expect(parseKnownVersions(null)).toEqual({})
  })

  it('caps and dedupes the ids', () => {
    const many = Array.from({ length: 40 }, (_, i) => `id${i}`).join(',')
    expect(parseBatchIds(many)).toHaveLength(THUMB_BATCH_MAX)
    expect(parseBatchIds('a,a,,b')).toEqual(['a', 'b'])
    expect(parseBatchIds(null)).toEqual([])
  })
})

describe('the companion half — scope', () => {
  const nodes = [
    { id: 'b1', kind: 'browser' },
    { id: 'b2', kind: 'browser' },
    { id: 't1', kind: 'terminal' }
  ]

  it('answers no-frame for an id outside the canvas, and never drops it', () => {
    const frame = { data: Buffer.from('x'), type: 'image/jpeg', at: 1 }
    const lookup = scopedThumbLookup(scopedBrowserIds(nodes), () => frame)
    // b9 is another workspace's browser; t1 is this canvas but not a browser.
    expect(batchFrames(['b1', 'b9', 't1'], {}, lookup)).toEqual([
      { id: 'b1', at: 1, type: 'image/jpeg', data: Buffer.from('x').toString('base64') },
      { id: 'b9', at: null },
      { id: 't1', at: null }
    ])
  })

  it('a card of this canvas with no frame yet is still a member — it is asked, and answers no-frame', () => {
    const browsers = scopedBrowserIds(nodes)
    // The route heartbeats by membership, so b2 (no frame) is asked; b9 is not.
    expect([...['b1', 'b2', 'b9'].filter((id) => browsers.has(id))]).toEqual(['b1', 'b2'])
    const frames = new Map([['b1', { data: Buffer.from('x'), type: 'image/jpeg', at: 1 }]])
    const lookup = scopedThumbLookup(browsers, (id) => frames.get(id))
    expect(batchFrames(['b2'], {}, lookup)).toEqual([{ id: 'b2', at: null }])
  })
})

describe('the phone half', () => {
  const nodes = [
    { id: 'in', kind: 'browser', x: 0, y: 0, width: 100, height: 100 },
    { id: 'edge', kind: 'browser', x: 950, y: 0, width: 100, height: 100 },
    { id: 'out', kind: 'browser', x: 2000, y: 2000, width: 100, height: 100 },
    { id: 'note', kind: 'note', x: 0, y: 0, width: 100, height: 100 }
  ]
  const view = { left: -10, top: -10, right: 1000, bottom: 800 }

  it('names only the browser cards the screen shows, edges included', () => {
    expect(viewportBrowserIds(nodes, view)).toEqual(['in', 'edge'])
  })

  it('sends known versions only for the ids being asked', () => {
    expect(knownVersions({ a: 1, b: 2, z: 9 }, ['a', 'b', 'c'])).toBe('a:1,b:2')
    expect(knownVersions({}, ['a'])).toBe('')
  })

  it('folds an answer: failures back off, versions are kept, changed frames are handed back', () => {
    const outcome = applyThumbBatch(
      [
        { id: 'a', at: null },
        { id: 'b', at: 5 },
        { id: 'c', at: 6, type: 'image/jpeg', data: 'QUJD' }
      ],
      {},
      { b: 5 },
      1_000
    )
    expect(Object.keys(outcome.backoffs)).toEqual(['a'])
    expect(outcome.versions).toEqual({ b: 5, c: 6 })
    expect(outcome.changed).toEqual([{ id: 'c', type: 'image/jpeg', data: 'QUJD' }])
  })

  it('never moves a version backwards, and never hands back bytes older than what is held', () => {
    // Two polls in flight; the older answer lands second.
    const outcome = applyThumbBatch(
      [{ id: 'c', at: 5, type: 'image/jpeg', data: 'OLD' }],
      {},
      { c: 7 },
      1_000
    )
    expect(outcome.versions).toEqual({ c: 7 })
    expect(outcome.changed).toEqual([])
    // An equal version is the unchanged case and still ends the backoff.
    const same = applyThumbBatch([{ id: 'c', at: 7 }], { c: { failures: 1, until: 5_000 } } as never, { c: 7 }, 1_000)
    expect(same.backoffs).toEqual({})
  })

  it('never mutates what it was given', () => {
    const backoffs = {}
    const versions = { b: 5 }
    applyThumbBatch([{ id: 'a', at: null }, { id: 'c', at: 6, type: 'image/png', data: 'x' }], backoffs, versions, 1)
    expect(backoffs).toEqual({})
    expect(versions).toEqual({ b: 5 })
  })
})
