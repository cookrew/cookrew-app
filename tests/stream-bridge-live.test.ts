// A SHELL CARD IS NOT A SESSION, AND THAT USED TO CRASH THE CANVAS.
//
// Main answers `null` from streamTail for a terminal with no stream source —
// a plain Shell card has none, and neither has an agent whose session file has
// not been written yet (stream-ipc.ts: `sourceOf` returns null, the route
// returns null). The bridge's live poll forwarded that null to `onTail`, whose
// type promises a tail, and the reducer's withTail read `tail.block` off it:
// "Cannot read properties of null (reading 'block')", the whole canvas
// replaced by its error boundary, from nothing worse than opening a shell.
//
// So: a null tail is not an update, and the poll emits nothing for it. A real
// tail still arrives, which is what keeps this from passing vacuously.
import { afterEach, describe, expect, it, vi } from 'vitest'

const tails: (unknown | null)[] = []
const bridge = {
  streamOpen: () => Promise.resolve({ index: [], tail: null, backwardsCursor: null }),
  streamBlocks: () => Promise.resolve({ blocks: [], marks: {}, total: 0 }),
  streamTail: () => Promise.resolve(tails.shift() ?? null),
  streamMarks: () => Promise.resolve({})
}

vi.mock('../src/renderer/src/api', () => ({ cookrew: () => bridge }))
vi.mock('../src/renderer/src/latest-changed-bus', () => ({
  hasLatestPush: () => false,
  subscribeLatestChanged: () => () => undefined
}))

const { createBridgeStreamTransport } = await import('../src/renderer/src/stream/stream-bridge')

const BLOCK = {
  id: 'b1',
  index: 1,
  prompt: 'ask',
  reply: 'answer',
  activity: [],
  startedAt: 1,
  endedAt: 2,
  ordinal: 1,
  compacted: false
}

/** Run the transport's live poll until it has had `rounds` chances to emit. */
async function listen(rounds: number): Promise<unknown[]> {
  const seen: unknown[] = []
  const stop = createBridgeStreamTransport().live('terminal-1', {
    onTail: (tail) => {
      seen.push(tail)
    },
    onMark: () => undefined,
    onRollback: () => undefined,
    onState: () => undefined,
    onError: () => undefined
  })
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(3000)
  stop()
  return seen
}

describe('the stream bridge live poll', () => {
  afterEach(() => {
    tails.length = 0
    vi.useRealTimers()
  })

  it('emits nothing for a terminal with no session', async () => {
    vi.useFakeTimers()
    tails.push(null, null)
    expect(await listen(3)).toEqual([])
  })

  it('still emits a real tail', async () => {
    vi.useFakeTimers()
    const tail = { block: BLOCK, final: true, ordinal: 1, total: 1 }
    tails.push(tail)
    expect(await listen(2)).toContainEqual(tail)
  })
})
