// A PHONE ON A LINE, FOR THE H.264 SENDER (cast-video-out.ts), run on vitest's fake clock.
//
// Down: one bottleneck carries the Mac's chunks one after another at `kbps`, then half a round trip.
// Up: the phone acknowledges as useBrowserStream.ts + path/bridge-socket.ts do: the newest chunk only,
// at most one acknowledgement POST every BRIDGE_ACK_MIN_MS, at most BRIDGE_UP_IN_FLIGHT of them out,
// each taking half a round trip plus jitter, and stalling when the script says so.
// Pictures come as a person makes them: scrolling (a new picture every 33 ms), at rest (none), or a
// caret blinking (a small picture every 500 ms). Key frames are larger.
import { vi } from 'vitest'
import { CAST_CODEC } from '../../src/shared/cast-video'
import type { CastEncoderSession } from '../../src/main/cast-encoder'
import type { OutboundFrame } from '../../src/main/cast-viewer'
import { VideoOut } from '../../src/main/cast-video-out'
import { BRIDGE_ACK_MIN_MS, BRIDGE_UP_IN_FLIGHT } from '../../src/renderer/src/path/bridge-socket'

export type Phase =
  | { readonly kind: 'scroll'; readonly seconds: number; readonly frameKB: number }
  | { readonly kind: 'rest'; readonly seconds: number }
  | { readonly kind: 'blink'; readonly seconds: number; readonly frameKB: number }

export interface LineSim {
  readonly kbps: number
  readonly rttMs: number
  readonly phases: readonly Phase[]
  /** Up to this much extra on each acknowledgement's way up, drawn from a fixed seed. */
  readonly jitterMs?: number
  /** From this second the line carries `slowerKbps` instead. */
  readonly slowerAt?: number
  readonly slowerKbps?: number
  /** From `slowerAt` the round trip is this instead (another network). */
  readonly slowerRttMs?: number
  /** The way up stops for `stallMs` every `stallEveryMs` (a phone's uplink hiccup). */
  readonly stallEveryMs?: number
  readonly stallMs?: number
  /** Acknowledgement POSTs the phone keeps out at once (BRIDGE_UP_IN_FLIGHT unless said). */
  readonly ackPostsInFlight?: number
  /** At these seconds the phone asks for a key frame (its chain broke, or it came back on another network). */
  readonly keyAsksAt?: readonly number[]
  /** A key frame is this many times a delta. */
  readonly keyTimes?: number
}

export interface LineResult {
  /** Chunks decoded a second during the last phase. */
  readonly fps: number
  /** How long a chunk sent now would wait behind earlier ones on the line, averaged over the last phase. */
  readonly queueMs: number
  readonly windowKB: number
}

const CTX = { displayScale: 2, viewportWidth: 390, viewportHeight: 700 }
const picture = (seq: number): OutboundFrame => ({
  seq,
  base64: `pic${seq}`,
  bytes: Buffer.from(`pic${seq}`),
  size: { width: 780, height: 1400 },
  meta: { displayScale: 2, pageScaleFactor: 1, mobile: true, revision: 1 }
})

/** A small fixed-seed generator: the same jitter every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

export async function runLine(sim: LineSim): Promise<LineResult> {
  const random = seeded(7)
  const start = Date.now()
  const at = (): number => Date.now() - start
  let frameKB = 1
  const keyTimes = sim.keyTimes ?? 5
  const session: CastEncoderSession = {
    encode: async (_base64, key) => ({ data: 'A'.repeat(Math.ceil((frameKB * (key ? keyTimes : 1) * 1024 * 4) / 3)), key }),
    close: () => undefined
  }
  const later = (ms: number): boolean => sim.slowerAt !== undefined && ms >= sim.slowerAt * 1000
  const rttAt = (ms: number): number => (later(ms) ? (sim.slowerRttMs ?? sim.rttMs) : sim.rttMs)
  const speedAt = (ms: number): number => (sim.slowerAt !== undefined && ms >= sim.slowerAt * 1000 ? (sim.slowerKbps ?? sim.kbps) : sim.kbps)

  // The way down.
  let lineFreeAt = 0
  // The phone.
  let newestDecoded = 0
  let told = 0
  let acksOut = 0
  let lastAckSent = -Infinity
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  const decodedAt: number[] = []
  let out: VideoOut | null = null

  const upDelay = (): number => {
    let delay = rttAt(at()) / 2 + (sim.jitterMs ? random() * sim.jitterMs : 0)
    if (sim.stallEveryMs && sim.stallMs) {
      const arrive = at() + delay
      const into = arrive % sim.stallEveryMs
      if (into < sim.stallMs) delay += sim.stallMs - into
    }
    return delay
  }
  const sendAck = (): void => {
    if (ackTimer !== null || newestDecoded <= told) return
    const wait = Math.max(0, lastAckSent + BRIDGE_ACK_MIN_MS - at())
    if (wait > 0 || acksOut >= (sim.ackPostsInFlight ?? BRIDGE_UP_IN_FLIGHT)) {
      ackTimer = setTimeout(() => {
        ackTimer = null
        sendAck()
      }, Math.max(wait, 20))
      return
    }
    const n = newestDecoded
    told = n
    lastAckSent = at()
    acksOut += 1
    const up = upDelay()
    setTimeout(() => out?.ack(n), up)
    // The POST is out until its answer is back.
    setTimeout(() => {
      acksOut -= 1
      sendAck()
    }, up + rttAt(at()) / 2)
  }

  out = new VideoOut({
    session,
    codec: CAST_CODEC,
    send: (message) => {
      if (message.t !== 'vframe') return
      const n = message.n as number
      const bytesKB = (String(message.data).length * 3) / 4 / 1024
      const now = at()
      lineFreeAt = Math.max(now, lineFreeAt) + (bytesKB / speedAt(now)) * 1000
      setTimeout(() => {
        decodedAt.push(at())
        newestDecoded = Math.max(newestDecoded, n)
        sendAck()
      }, lineFreeAt + rttAt(now) / 2 - now)
    },
    ready: () => true,
    onceReady: () => undefined,
    delivered: () => undefined,
    failed: () => undefined,
    now: () => Date.now()
  })

  for (const second of sim.keyAsksAt ?? []) setTimeout(() => out?.keyAsked(), second * 1000)
  let seq = 0
  let lastPhaseStart = 0
  const queues: number[] = []
  for (const [index, phase] of sim.phases.entries()) {
    const phaseStart = at()
    const last = index === sim.phases.length - 1
    if (last) lastPhaseStart = phaseStart
    let nextPicture = phaseStart
    while (at() - phaseStart < phase.seconds * 1000) {
      if (phase.kind !== 'rest' && at() >= nextPicture) {
        frameKB = phase.frameKB
        seq += 1
        out.offer(picture(seq), CTX)
        nextPicture += phase.kind === 'scroll' ? 33 : 500
      }
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(33)
      if (last) queues.push(Math.max(0, lineFreeAt - at()))
    }
  }
  const windowKB = Math.round(out.windowBytes / 1024)
  out.close()
  const lastSeconds = (at() - lastPhaseStart) / 1000
  const fps = decodedAt.filter((t) => t >= lastPhaseStart).length / lastSeconds
  const queueMs = queues.reduce((sum, q) => sum + q, 0) / Math.max(1, queues.length)
  return { fps, queueMs, windowKB }
}
