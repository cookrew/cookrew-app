// ENDING A PANE, WITH EVIDENCE.
//
// "Killed" is a claim about a process. Box test 2 (2026-11-05) closed a card
// after a relaunch: the toast said killed, the card went, terminal.killed was
// logged, and the counter in the pane kept counting, unreachable, because
// nothing had looked. With a real agent that is a Claude left running with
// bypassed permissions.
//
// So the answer is earned: the pane is gone from the backend AND its root
// process is gone. A backend that closes a pane drops the pty, the process
// takes a hangup, and most die there; one that ignores it outlives its pane, so
// it is signalled, and only after the backend has let go of it. A backend that
// cannot answer proves nothing, which is a failure to confirm and never a
// success. A pane that is there and whose process cannot be named is not even
// closed: nothing could prove its end afterwards, and the pane is the handle.

type MaybeAsync<T> = T | Promise<T>

export interface PaneEndDeps {
  /** The pane's root process, while it has one. Read before the close: afterwards the pane cannot name it. */
  pid: () => MaybeAsync<number | null>
  /** Ask the backend to close it. Best effort; the polls below decide what happened. */
  close: () => void
  /** Is the pane still there? Null when the backend could not say. */
  exists: () => MaybeAsync<boolean | null>
  alive: (pid: number) => MaybeAsync<boolean>
  signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type PaneEnd =
  | { readonly ended: true; readonly pid: number | null }
  | { readonly ended: false; readonly pid: number | null; readonly reason: string }

const POLL_MS = 100
/** Share of the deadline a close gets before it is asked again, and before a hangup is judged ignored. */
const RETRY_AT = 0.4
const SIGKILL_AT = 0.7

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A close that throws is a close that did not happen; the polls report it. */
function closeQuietly(close: () => void): void {
  try {
    close()
  } catch (error) {
    console.error('Closing a pane failed:', error)
  }
}

/** A backend that throws gave no answer, which is the same as saying nothing. */
async function asked<T>(read: () => MaybeAsync<T | null>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

function survivorReason(exists: boolean | null, pid: number | null, timeoutMs: number): string {
  if (exists === null) return 'could not confirm it ended: the terminal backend did not answer'
  if (exists === false) return `process ${pid} is still running ${timeoutMs} ms after the close`
  return `its pane is still open ${timeoutMs} ms after the close`
}

/** Close a pane and report what became of it. Never throws. */
export async function endPane(deps: PaneEndDeps, timeoutMs = 5000): Promise<PaneEnd> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const before = await asked(deps.exists)
  const pid = (await asked(deps.pid)) ?? (before === false ? null : await asked(deps.pid))
  if (pid === null && before !== false) {
    return { ended: false, pid, reason: 'could not read its process, so it was left as it is' }
  }
  closeQuietly(deps.close)
  const started = now()
  let retried = false
  let termed = false
  let killed = false
  for (;;) {
    const exists = await asked(deps.exists)
    // Asked only once the backend has let go: until then the pane answers for it.
    const running = exists === false && pid !== null && (await deps.alive(pid))
    if (exists === false && !running) return { ended: true, pid }
    const elapsed = now() - started
    if (elapsed >= timeoutMs * RETRY_AT && exists !== false && !retried) {
      retried = true
      closeQuietly(deps.close)
    }
    // Only once the backend has let go: while it still holds the pane the
    // process is its to end, and this pid is the backend's word for a pane
    // that may be mid-close.
    let signalled = false
    if (running && elapsed >= timeoutMs * RETRY_AT && !termed) {
      termed = true
      signalled = true
      deps.signal(pid, 'SIGTERM')
    }
    if (running && elapsed >= timeoutMs * SIGKILL_AT && !killed) {
      killed = true
      signalled = true
      deps.signal(pid, 'SIGKILL')
    }
    // A signal sent at the deadline gets one look at what it did.
    if (elapsed >= timeoutMs && !signalled) return { ended: false, pid, reason: survivorReason(exists, pid, timeoutMs) }
    await sleep(POLL_MS)
  }
}
