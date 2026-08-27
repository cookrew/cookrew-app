import { describe, expect, it } from 'vitest'
import {
  activeIdentityForOffsets,
  transcriptIdentitySpace
} from '../src/renderer/src/TranscriptView'

describe('transcriptIdentitySpace', () => {
  it('keeps new tail blocks visible while the lower-priority index catches up', () => {
    expect(
      transcriptIdentitySpace([1, 2, 3], [{ index: 3 }, { index: 4 }, { index: 5 }]),
    ).toEqual([1, 2, 3, 4, 5])
  })

  it('degrades to loaded block identities before metadata arrives', () => {
    expect(transcriptIdentitySpace([], [{ index: 240 }, { index: 239 }])).toEqual([239, 240])
  })
})

describe('activeIdentityForOffsets', () => {
  const ids = [1, 2, 3, 4, 5]
  const tops = new Map(ids.map((id) => [id, (id - 1) * 100]))

  it('reads the current offset table with logarithmic probes', () => {
    let probes = 0
    expect(activeIdentityForOffsets(ids, (id) => {
      probes += 1
      return tops.get(id)
    }, 305)).toBe(4)
    expect(probes).toBeLessThanOrEqual(3)
  })

  it('returns null above the first identity', () => {
    expect(activeIdentityForOffsets(ids, (id) => tops.get(id), -1)).toBeNull()
  })
})
