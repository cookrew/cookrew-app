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
 * A failed request drops only its own bytes (same contract as the
 * fire-and-forget POST it replaces); the bytes behind it still go.
 */

type SendRaw = (terminalId: string, data: string) => Promise<unknown>

interface Lane {
  chunks: string[]
  inFlight: boolean
}

/** Submit-capable per ownerSubmit's own classifier boundary. */
const carriesEnter = (chunk: string): boolean => chunk.includes('\r') || chunk.includes('\n')

export function createRawInputQueue(
  send: SendRaw
): (terminalId: string, data: string) => void {
  const lanes = new Map<string, Lane>()

  const pump = (terminalId: string, lane: Lane): void => {
    if (lane.inFlight || lane.chunks.length === 0) return
    let data: string
    if (carriesEnter(lane.chunks[0])) {
      data = lane.chunks.shift() as string
    } else {
      data = ''
      while (lane.chunks.length > 0 && !carriesEnter(lane.chunks[0])) {
        data += lane.chunks.shift() as string
      }
    }
    lane.inFlight = true
    void send(terminalId, data)
      .catch(() => undefined)
      .finally(() => {
        lane.inFlight = false
        pump(terminalId, lane)
      })
  }

  return (terminalId, data) => {
    if (data === '') return
    const lane = lanes.get(terminalId) ?? { chunks: [], inFlight: false }
    lanes.set(terminalId, lane)
    lane.chunks.push(data)
    pump(terminalId, lane)
  }
}
