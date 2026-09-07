// THE DRAWER'S WINDOWS, BY IDENTITY (one-stream T3).
//
// The pager used to address a window by a NUMBER — beforeIndex / afterIndex /
// aroundIndex over one file's own numbering — and a /compact restarted that
// numbering, so a jump into an earlier segment landed on a different turn than
// the one that was clicked. Identities do not restart. This module is the
// whole translation: the view keeps thinking in ordinals (its geometry, its
// placeholders and the rail's fractions are all laid out in them), and every
// FETCH is named by an identity.
//
// IT ALSO FIXES THE COORDINATE THE BLOCKS ARRIVE IN. A StreamBlock carries
// two numbers: `index`, its position inside its own file, and `ordinal`, its
// position in the whole chain. The drawer must use the ordinal or a compacted
// card renders two blocks at T1. The main process's own /trace adapter does
// exactly this remap (traceBlockOf); this is its half in the renderer.
//
// ONE RENDERING PATH, TWO SOURCES. Every window says whether it is live or
// replay, and that flag is the ONLY difference between them — the blocks, the
// view model and the markup are identical. See stream-view.ts.

import type { TraceBlock } from '../../../shared/trace-blocks'
import type { StreamBlock, StreamRenderSource } from './stream-types'
import type { StreamHandle } from './use-stream'

/** A window as the drawer consumes it: blocks in STREAM coordinates. */
export interface StreamWindow {
  blocks: TraceBlock[]
  /** Length of the whole stream, so the virtualizer can size itself. */
  total: number
  /** Live tail growth, or a page somebody scrolled to. */
  render: StreamRenderSource
}

/**
 * A block in the stream's coordinate space.
 *
 * `index` becomes the chain ordinal, because that is the number the rail, the
 * placeholders and every cursor in the view are expressed in. The rest of the
 * block is passed through untouched — this design keeps today's block shape
 * exactly, and a projection that quietly dropped a field would be a visibly
 * poorer answer than the route it replaces.
 */
export function streamCoords(block: StreamBlock): TraceBlock {
  return { ...block, index: block.ordinal }
}

export interface StreamPager {
  /** Ordinals the stream holds, ascending — the continuous scroll space. */
  identities: number[]
  total: number
  /** The window CONTAINING an ordinal — a jump or a scroll into history. */
  around: (ordinal: number, limit?: number) => Promise<StreamWindow>
  /** The window AFTER an ordinal — ordinary growth. */
  after: (ordinal: number, limit?: number) => Promise<StreamWindow>
  /** The newest window. */
  tail: (limit?: number) => Promise<StreamWindow>
}

/**
 * The pager over one stream. Every call resolves an ordinal to an identity
 * FIRST and asks by that; an ordinal the index does not hold resolves to
 * nothing and the honest answer is an empty window, never a guess at a
 * neighbouring turn.
 */
export function streamPagerOf(stream: StreamHandle): StreamPager {
  const identityOf = (ordinal: number): string | null =>
    stream.index.find((row) => row.ordinal === ordinal)?.identity ?? null
  const newest = (): string | null =>
    stream.index[stream.index.length - 1]?.identity ?? null

  const shape = (
    blocks: readonly StreamBlock[],
    total: number | undefined,
    render: StreamRenderSource
  ): StreamWindow => ({
    blocks: blocks.map(streamCoords),
    total: total ?? stream.total,
    render
  })

  return {
    identities: stream.index.map((row) => row.ordinal),
    total: stream.total,
    around: async (ordinal, limit) => {
      const identity = identityOf(ordinal)
      if (identity === null) return { blocks: [], total: stream.total, render: 'replay' }
      const page = await stream.blocksAround(identity, limit)
      // REPLAY: this window exists because somebody scrolled or jumped to it.
      // Whatever a live tail is allowed to do to the view — move it, announce
      // itself — must not happen here (stream-view.ts, mayFireSideEffects).
      return shape(page.blocks, page.total, 'replay')
    },
    after: async (ordinal, limit) => {
      const identity = identityOf(ordinal)
      const page = await stream.blocksAfter(identity, limit)
      return shape(page.blocks, page.total, 'live')
    },
    tail: async (limit) => {
      const identity = newest()
      // The newest window is the one CONTAINING the newest row, which is what
      // blocksAround computes; there is no "before the end" cursor and
      // inventing one would page off the end of the stream.
      const page =
        identity === null
          ? await stream.blocksAfter(null, limit)
          : await stream.blocksAround(identity, limit)
      return shape(page.blocks, page.total, 'live')
    }
  }
}
