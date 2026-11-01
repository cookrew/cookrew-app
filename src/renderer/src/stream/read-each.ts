/**
 * Read every id, at most `atOnce` at a time, resolving when all are done.
 *
 * The companion speaks HTTP/1.1 to the Mac: six connections per host, four of
 * them held by long-lived streams (events, levels, the open agent's terminal
 * and its live rail). A board read that fired every idle agent's tail at once
 * queued forty-odd requests behind the two free connections, and every
 * keystroke typed in LIVE waited behind all of them (2026-11-01: the prompt
 * box's words never reached the agent's line). A bounded pump leaves a
 * connection free for what a person is doing.
 */
export async function readEach(ids: readonly string[], read: (id: string) => Promise<void>, atOnce: number): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next]
      next += 1
      try {
        await read(id)
      } catch {
        // One failed read must not stop the rest of the board.
      }
    }
  }
  const workers = Math.max(1, Math.min(atOnce, ids.length))
  await Promise.all(Array.from({ length: workers }, worker))
}
