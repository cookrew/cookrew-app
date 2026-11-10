import { decodeFrame, type RelayFrame } from '../shared/relay-frame'
import type { LinkReceipt } from './canvas-link'
import { createRelayPace, type RelayPace } from './relay-pace'
import { createRtcOutbox, type OutboxSink } from './rtc-outbox'

/**
 * WHAT GOES UP THE MAC'S RELAY LINE NEXT — the uplink's twin of rtc-outbox's
 * job on the direct link, and the same outbox.
 *
 * Every answer this Mac gives a phone over the relay shares ONE uplink: a
 * chunked POST to cookrew.dev. Written straight into it, an 800 KB snapshot
 * went out ahead of every keystroke's answer behind it, an answer the phone
 * had already given up on still went out in full, and the relay's pong waited
 * in the same queue until a slow line was declared dead. On the owner's line
 * (2026-11-10, ~40 KB/s through a proxy) that was p99 33 s.
 *
 * So answers wait HERE, in lanes (one per exchange; rtc-outbox.ts), and only
 * the pace's window of them is let out on the line (relay-pace.ts, fed by the
 * relay's receipts). A lane holding little goes first; bulk lanes take turns.
 * A lane whose reader hung up is thrown away before it costs the line a byte.
 * A lane that piles up past LANE_HIGH asks the bridge to stop reading that
 * answer from the companion until it drains to LANE_LOW.
 *
 * The link's own pong does not come through here: canvas-link writes it
 * straight onto the line, behind at most a window.
 *
 * Against a registry that sends no receipts the budget falls back to Node's
 * own unsent count, which is what this line did before.
 */

/**
 * Raw bytes per `chunk` frame on the relay: one lane's turn on the line, and
 * the most a small answer waits behind (a frame already let out is never
 * split). 8 KB is ~11 KB as base64, a quarter second on the owner's 40 KB/s,
 * so one frame is about the pace's whole queue target there; the ~60 bytes of
 * frame around it are under 1%.
 */
export const RELAY_CHUNK = 8 * 1024
/** Node's unsent bytes allowed when the registry sends no receipts. */
export const RELAY_UNPACED_BUDGET = 64 * 1024
/** A lane holding this much stops reading its answer... */
export const RELAY_LANE_HIGH = 1024 * 1024
/** ...until it is down to this. */
export const RELAY_LANE_LOW = 256 * 1024
/** How soon to look again when the line was full and no receipt has come. */
export const RELAY_RETRY_MS = 25
/**
 * A lane paused this long without draining gives up its exchange. Pausing only
 * moves the backlog into the companion's own response (an event stream does
 * not wait for its reader), so a stream the line cannot carry would otherwise
 * grow in this process for ever. Aborted, an EventSource reconnects and is
 * sent a fresh snapshot instead of a backlog.
 */
export const RELAY_STUCK_MS = 30_000
/** Lane names remembered before the finished ones are swept out. */
const LANES_SWEPT_ABOVE = 256

/** The line, as far as the uplink needs one (canvas-link.ts). */
export interface RelayUplinkLine {
  readonly send: (line: string) => void
  readonly backlog: () => number
  readonly paced: () => boolean
  readonly onReceipt: (listener: (receipt: LinkReceipt) => void) => () => void
}

export interface RelayUplink {
  /** One frame up, on its exchange's lane. */
  readonly send: (line: string, frame: RelayFrame) => void
  /** A frame came down: a caller that hung up lets its lane go. */
  readonly heard: (line: string) => void
  /**
   * May the bridge keep reading this exchange's answer? False when its lane is
   * full, and then `resume` runs once it has drained, or `giveUp` if it has
   * not drained within RELAY_STUCK_MS.
   */
  readonly room: (id: string, resume: () => void, giveUp?: () => void) => boolean
  /** Bytes held here and not yet on the line, across every lane. */
  readonly queued: () => number
  /** Lane names remembered: bounded, for the health line and the tests. */
  readonly lanes: () => number
  /** The line ended: nothing held here is for anyone any more. */
  readonly reset: () => void
}

export interface RelayUplinkOptions {
  readonly pace?: RelayPace
  readonly retryMs?: number
  readonly stuckMs?: number
  readonly schedule?: (run: () => void, ms: number) => () => void
}

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const handle = setTimeout(run, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

const laneOf = (id: string): string => `x${id}`

export const createRelayUplink = (line: RelayUplinkLine, options: RelayUplinkOptions = {}): RelayUplink => {
  const pace = options.pace ?? createRelayPace()
  const stuckMs = options.stuckMs ?? RELAY_STUCK_MS
  const schedule = options.schedule ?? defaultSchedule
  const sink: OutboxSink = {
    send: (text) => line.send(text),
    get bufferedAmount() {
      return line.backlog()
    }
  }
  const outbox = createRtcOutbox({
    budget: () => (line.paced() ? pace.window() : RELAY_UNPACED_BUDGET),
    retryMs: options.retryMs ?? RELAY_RETRY_MS
  })
  /** Lanes that may still hold bytes; pruned as they are found empty. */
  const lanes = new Set<string>()

  const queued = (): number => {
    let sum = 0
    for (const lane of [...lanes]) {
      const held = outbox.queued(lane)
      if (held === 0) lanes.delete(lane)
      sum += held
    }
    return sum
  }

  line.onReceipt((receipt) => {
    pace.sample({ acked: receipt.acked, rttMs: receipt.rttMs, limited: queued() > 0 })
    outbox.pump()
  })

  return {
    send: (text, frame) => {
      const lane = 'id' in frame ? laneOf(frame.id) : 'link'
      // Swept here as well as on receipts: a registry that sends none would
      // otherwise leave every exchange this Mac ever answered in the set.
      if (lanes.size > LANES_SWEPT_ABOVE) queued()
      // An abort ends the answer: whatever of it still waits here is not wanted.
      if (frame.t === 'abort') outbox.drop(lane)
      lanes.add(lane)
      outbox.send(sink, lane, text)
    },
    heard: (text) => {
      // Cheap first: almost every frame down is an open or a body.
      if (!text.startsWith('{"t":"end"') && !text.startsWith('{"t":"abort"')) return
      const frame = decodeFrame(text)
      if (frame && (frame.t === 'end' || frame.t === 'abort')) outbox.drop(laneOf(frame.id))
    },
    room: (id, resume, giveUp) => {
      const lane = laneOf(id)
      if (outbox.queued(lane) <= RELAY_LANE_HIGH) return true
      let settled = false
      const cancel = giveUp
        ? schedule(() => {
            if (settled) return
            settled = true
            giveUp()
          }, stuckMs)
        : (): void => undefined
      outbox.whenBelow(lane, RELAY_LANE_LOW, () => {
        if (settled) return
        settled = true
        cancel()
        resume()
      })
      return false
    },
    queued,
    lanes: () => lanes.size,
    reset: () => {
      outbox.forget(sink)
      lanes.clear()
      pace.reset()
    }
  }
}
