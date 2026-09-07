// THE STREAM OVER THE DESKTOP BRIDGE (one-stream T3).
//
// The desktop renderer has no origin to fetch: `cookrew()` is the preload
// bridge and every read is an IPC invoke. The five stream reads are therefore
// five bridge methods with the SAME contract as the five HTTP routes, served
// in main by the same StreamService the routes use (stream-ipc.ts) — one
// reader, two doors, no second projection.
//
// LIVE, WITHOUT A SECOND CHANNEL. There is already a per-terminal push that
// says "this card's record changed": the file watch behind watchLatest /
// onLatestChanged, which the card preview and the rail's delta read both ride
// today. The stream subscribes to that same nudge and re-reads the tail and
// the folded marks — so the desktop gains no new watcher, no new socket and
// no new descriptor budget, and a build whose bridge has no push degrades to
// the slow poll that has always been the backstop.

import { cookrew } from '../api'
import { hasLatestPush, subscribeLatestChanged } from '../latest-changed-bus'
import { createAbsentStreamTransport, type StreamTransport } from './stream-transport'
import type { StreamMarks, StreamTail } from './stream-types'

/** How often the bridge re-reads when there is no push to ride. Matches the
 *  card preview's poll-only cadence — the rail's own tick, not faster. */
const POLL_ONLY_MS = 3000
/** With a push, the poll is only the correctness backstop for what a file
 *  watch coalesces or drops. */
const PUSH_BACKSTOP_MS = 10_000

/** The bridge methods this transport needs, all feature-detected. */
interface StreamBridge {
  streamOpen?: StreamTransport['open']
  streamIndex?: StreamTransport['index']
  streamBlocks?: StreamTransport['blocks']
  streamMark?: StreamTransport['mark']
  streamTail?: (terminalId: string) => Promise<StreamTail>
  streamMarks?: (terminalId: string) => Promise<Record<string, StreamMarks>>
  watchLatest?: (terminalId: string) => Promise<void> | void
  unwatchLatest?: (terminalId: string) => Promise<void> | void
}

/** True once this build's bridge can answer the stream at all. */
export function hasStreamBridge(): boolean {
  const bridge = cookrew() as unknown as StreamBridge
  return typeof bridge.streamOpen === 'function' && typeof bridge.streamBlocks === 'function'
}

export function createBridgeStreamTransport(): StreamTransport {
  const bridge = cookrew() as unknown as StreamBridge
  if (bridge.streamOpen === undefined || bridge.streamBlocks === undefined) {
    return createAbsentStreamTransport(
      'this build has no stream bridge — the rail cannot read the transcript'
    )
  }
  return {
    open: bridge.streamOpen,
    index: bridge.streamIndex ?? (() => Promise.resolve({ checkpoints: [] })),
    blocks: bridge.streamBlocks,
    mark:
      bridge.streamMark ??
      (() => Promise.reject(new Error('this build cannot write a checkpoint mark'))),
    live: (terminalId, handlers) => {
      let closed = false
      let lastMarks: Record<string, StreamMarks> = {}
      const readTail = async (): Promise<void> => {
        const tail = await bridge.streamTail?.(terminalId)
        if (!closed && tail !== undefined) handlers.onTail(tail)
      }
      const readMarks = async (): Promise<void> => {
        const next = await bridge.streamMarks?.(terminalId)
        if (closed || next === undefined) return
        for (const [identity, mark] of Object.entries(next)) {
          if (JSON.stringify(lastMarks[identity] ?? null) !== JSON.stringify(mark)) {
            handlers.onMark(identity, mark)
          }
        }
        // A CLEARED MARK IS A CHANGE, not an absence: the rail has to drop the
        // title, and a client that never hears about it keeps showing it.
        for (const identity of Object.keys(lastMarks)) {
          if (!(identity in next)) handlers.onMark(identity, null)
        }
        lastMarks = next
      }
      const pass = (): void => {
        void Promise.all([readTail(), readMarks()])
          .then(() => {
            if (!closed) handlers.onState('connected')
          })
          .catch((error: unknown) => {
            if (closed) return
            handlers.onState('reconnecting')
            handlers.onError(error instanceof Error ? error.message : String(error))
          })
      }

      const push = hasLatestPush()
      if (push) void bridge.watchLatest?.(terminalId)
      const offPush = push ? subscribeLatestChanged(terminalId, pass) : undefined
      pass()
      const timer = setInterval(pass, push ? PUSH_BACKSTOP_MS : POLL_ONLY_MS)

      return () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        offPush?.()
        if (push) void bridge.unwatchLatest?.(terminalId)
        handlers.onState('off')
      }
    }
  }
}
