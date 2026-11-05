/**
 * Ordered keystrokes for the phone's terminal, one request in flight.
 *
 * Each keystroke used to leave as its own POST, unserialized. Two costs on
 * the same link: parallel fetches can arrive REORDERED — 'ab' landing as
 * 'ba', an ordering the desktop's IPC gives for free — and a burst of N
 * keystrokes paid N sets of headers and N round trips where round trips are
 * the scarce thing (a relayed tailnet runs 300ms–2.5s each).
 *
 * The queue holds ONE request in flight per terminal; bytes typed meanwhile
 * ride the next request. There is no timer — an isolated keystroke leaves
 * immediately, and the batch window is exactly the natural in-flight time,
 * so coalescing grows with the link's slowness instead of taxing a fast one.
 *
 * THE BOUNDARY RULE: batching must never change what the server reads.
 * ownerSubmit classifies each request body whole — CR-free chunks
 * concatenated are byte-identical on the pty, but a merged batch that ENDED
 * in an Enter would take the bracketed-paste path the discrete keys never
 * took (vim's normal mode reads a paste very differently from the commands
 * those keys were). So a chunk carrying CR/LF keeps a request of its own —
 * exactly the shape it had before batching existed, which also preserves
 * the one-request paste+Enter delivery the paste-swallow guard relies on.
 *
 * A request the Mac answered with a refusal drops only its own bytes (same
 * contract as the fire-and-forget POST it replaces); the bytes behind it
 * still go.
 *
 * AND A HUNG ONE IS A FAILED ONE. One request in flight means one request
 * that never answers stops the terminal: on 2026-10-18 the phone's Tailscale
 * dropped mid-request, the plane fell back to the relay, and the typing that
 * followed queued behind a fetch the OS would not give up on for minutes. A
 * request gets RAW_INPUT_DEADLINE_MS; past it it is aborted (a 'TimeoutError',
 * which plane-fetch.ts counts against the plane).
 *
 * AND NO ANSWER IS SENT AGAIN, NOT DROPPED. A batch that got no answer — the
 * deadline passed, the plane it went on was left (plane-fetch.ts aborts it),
 * the WebRTC link closed under it — used to lose its bytes: the letters typed
 * just as the phone moved between LAN and the relay never arrived. Now each
 * batch carries an id and is sent again, on whatever plane is current, until
 * it is answered or RAW_INPUT_GIVE_UP_MS has passed; the Mac types an id once
 * however often it arrives (main/once-by-key.ts), so a batch that did land
 * and lost only its answer is not typed twice. An ANSWER — any status at all
 * — is final: those bytes are never sent again.
 */

/** Long enough for a relayed round trip, short enough that typing never looks dead. */
export const RAW_INPUT_DEADLINE_MS = 6_000
/** Waits before each repeat of a batch that got no answer; the last one repeats. */
export const RAW_INPUT_RETRY_MS = [0, 250, 500, 1_000, 2_000] as const
/** Past this since its first try, a batch is given up on. */
export const RAW_INPUT_GIVE_UP_MS = 30_000

type SendRaw = (terminalId: string, data: string, signal: AbortSignal, id: string) => Promise<unknown>

export interface RawInputQueueOptions {
  readonly deadlineMs?: number
  readonly giveUpMs?: number
  /** Did this failure come WITHOUT an answer? Only those are sent again. */
  readonly retryable?: (error: unknown) => boolean
  /** The Mac answered and would not take them: they will not go again. */
  readonly refused?: (terminalId: string, data: string, error: unknown) => void
  /** Names this page's batches; the Mac keys its memory of them by it. */
  readonly nonce?: string
  readonly now?: () => number
}

interface Batch {
  readonly data: string
  readonly id: string
  readonly firstAt: number
  tries: number
}

interface Lane {
  chunks: string[]
  inFlight: boolean
}

/** Submit-capable per ownerSubmit's own classifier boundary. */
const carriesEnter = (chunk: string): boolean => chunk.includes('\r') || chunk.includes('\n')
/** Sent on their own: an Enter (see above), and an Esc, which merged into a batch would interrupt nothing. */
const goesAlone = (chunk: string): boolean => carriesEnter(chunk) || chunk === '\x1b'

const pageNonce = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 13)
    : Math.random().toString(36).slice(2, 15)

export function createRawInputQueue(
  send: SendRaw,
  options: RawInputQueueOptions = {}
): (terminalId: string, data: string) => void {
  const deadlineMs = options.deadlineMs ?? RAW_INPUT_DEADLINE_MS
  const giveUpMs = options.giveUpMs ?? RAW_INPUT_GIVE_UP_MS
  const retryable = options.retryable ?? ((): boolean => false)
  const now = options.now ?? ((): number => Date.now())
  const nonce = options.nonce ?? pageNonce()
  const lanes = new Map<string, Lane>()
  let serial = 0

  const attempt = (terminalId: string, lane: Lane, batch: Batch): void => {
    batch.tries += 1
    const abort = new AbortController()
    let settled = false
    const finish = (again: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (again && now() - batch.firstAt < giveUpMs) {
        const wait = RAW_INPUT_RETRY_MS[Math.min(batch.tries - 1, RAW_INPUT_RETRY_MS.length - 1)]
        setTimeout(() => attempt(terminalId, lane, batch), wait)
        return
      }
      lane.inFlight = false
      pump(terminalId, lane)
    }
    // The lane moves on at the deadline even if the abort is not honoured
    // (a body still arriving): nothing behind it waits on it again.
    const deadline = setTimeout(() => {
      abort.abort(new DOMException('no answer in time', 'TimeoutError'))
      finish(true)
    }, deadlineMs)
    let sent: Promise<unknown>
    try {
      sent = send(terminalId, batch.data, abort.signal, batch.id)
    } catch (error) {
      sent = Promise.reject(error)
    }
    sent.then(
      () => finish(false),
      (error: unknown) => {
        const again = retryable(error)
        if (!again && !settled) options.refused?.(terminalId, batch.data, error)
        finish(again)
      }
    )
  }

  const pump = (terminalId: string, lane: Lane): void => {
    if (lane.inFlight || lane.chunks.length === 0) return
    let data: string
    if (goesAlone(lane.chunks[0])) {
      data = lane.chunks.shift() as string
    } else {
      data = ''
      while (lane.chunks.length > 0 && !goesAlone(lane.chunks[0])) {
        data += lane.chunks.shift() as string
      }
    }
    lane.inFlight = true
    attempt(terminalId, lane, { data, id: `${nonce}.${(serial += 1).toString(36)}`, firstAt: now(), tries: 0 })
  }

  return (terminalId, data) => {
    if (data === '') return
    const lane = lanes.get(terminalId) ?? { chunks: [], inFlight: false }
    lanes.set(terminalId, lane)
    lane.chunks.push(data)
    pump(terminalId, lane)
  }
}
