// Screencast ack pacing — the interactive-browser latency knob.
//
// CDP delivers Page.screencastFrame and won't send the next until we call
// Page.screencastFrameAck. If we ack the instant a frame arrives, CDP produces
// frames as fast as it can encode them and they pile up in the WebSocket send
// buffer whenever the LAN is slower than the encoder — latency grows without
// bound (buffer-bloat). Instead we ack only once the socket has DRAINED the
// previous frame, capping in-flight work to ~one frame and holding latency near
// the true network RTT. `drainThreshold` trades fps for latency: smaller = ack
// held sooner = lower latency, fewer frames; larger = smoother, laggier.
//
// Pure so the policy unit-tests without a socket or CDP.

/** Default socket-buffer tolerance before an ack is deferred (bytes). */
export const DEFAULT_DRAIN_THRESHOLD = 48_000

export interface AckDecision {
  /** Ack immediately (request the next frame now). */
  ackNow: boolean
  /** Hold the ack until the socket emits 'drain'. */
  deferUntilDrain: boolean
}

/**
 * Given the socket's current bufferedAmount, decide whether to ack the frame we
 * just sent. Ack when the buffer is at/under the threshold; otherwise defer
 * until it drains.
 */
export function decideAck(opts: { bufferedAmount: number; drainThreshold: number }): AckDecision {
  const drained = opts.bufferedAmount <= opts.drainThreshold
  return { ackNow: drained, deferUntilDrain: !drained }
}
