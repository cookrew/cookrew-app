import { describe, expect, it } from 'vitest'
import { batchFrames, parseBatchIds, parseKnownVersions, scopeBatchIds, THUMB_BATCH_MAX } from '../src/main/browser-thumb-batch'
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
  it('keeps only the browser cards of the canvas the client is scoped to', () => {
    const nodes = [
      { id: 'b1', kind: 'browser' },
      { id: 't1', kind: 'terminal' }
    ]
    // b9 is another workspace's browser; t1 is this canvas but not a browser.
    expect(scopeBatchIds(['b1', 'b9', 't1'], nodes)).toEqual(['b1'])
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

  it('never mutates what it was given', () => {
    const backoffs = {}
    const versions = { b: 5 }
    applyThumbBatch([{ id: 'a', at: null }, { id: 'c', at: 6, type: 'image/png', data: 'x' }], backoffs, versions, 1)
    expect(backoffs).toEqual({})
    expect(versions).toEqual({ b: 5 })
  })
})
