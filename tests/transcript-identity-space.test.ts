import { describe, expect, it } from 'vitest'
import { transcriptIdentitySpace } from '../src/renderer/src/TranscriptView'

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
