import { safeCallReply, type SafeReply } from './call-reply'
import type { CallIdentity } from './call-inflight'

/**
 * RUN ONE TURN AGAINST THE FORK (§9 · §10 · ④ · S4).
 *
 * The only place a stranger's bytes reach a real pty. Everything before this
 * decided whether they may; this decides what actually happens when they do.
 *
 * THE FORK, ALWAYS. The terminal id here comes from call-session, which is
 * structurally incapable of returning the original — see the property test over
 * subjects and conversation names. Nothing in this file resolves a terminal by
 * name, by focus, or by anything else that could reach the session the owner is
 * typing into.
 *
 * AND IT IS ALSO WHERE A REVOKE LANDS. Velvet's ruling is that revoke stops
 * calls already running, so this is the seam where "already running" is a thing
 * that can be stopped. Two promises, kept separately because they fail
 * differently: the reply NEVER reaches a revoked caller — decided here, and
 * unconditional — and the work itself is told to stop, which is best-effort in
 * the honest sense that a model mid-token stops when its runner notices.
 */

export type CallRunFailure =
  /** The fork's pty is not attached — parked, retired, or never spawned. */
  | 'not_running'
  /** The fork's context has not landed yet and waiting for it timed out. */
  | 'not_ready'
  /** A producer refusal: another submission, a dispatch, a contaminated box. */
  | 'busy'
  /**
   * The owner took the access away while this very call was running.
   *
   * Not 'busy'. Every other failure here means NOT NOW, TRY AGAIN; this one
   * means the caller is no longer entitled and retrying is pointless. Told
   * apart on the wire too — 403, not 409.
   */
  | 'revoked'

export type CallRunResult =
  | ({ ok: true } & SafeReply)
  | { ok: false; reason: CallRunFailure }

export interface CallRunDeps {
  /** The fork's live pty session, or undefined when it is not attached. */
  sessionOf: (forkId: string) => unknown | undefined
  /** Resolves once this fork's context injection has landed (fork.ts). */
  ready: (forkId: string) => Promise<void>
  /**
   * askTerminal, threaded so this module needs no pty of its own to test.
   *
   * The signal is the ask's own cancellation scope — the one already wired to
   * retirement and to shutdown, which reaches every phase of an ask rather
   * than only its submission. Revoke fires the same seam; there is no second
   * cancellation path to keep in agreement with this one.
   */
  ask: (session: unknown, prompt: string, signal?: AbortSignal) => Promise<string>
  /**
   * Liveness fact 3, and the handle a revoke reaches this call by. Held for the
   * WHOLE call, released in a finally.
   */
  inFlight: (identity: CallIdentity, cancel: () => void) => () => void
  /**
   * How long to wait for a cold fork's context before refusing.
   *
   * There has to be a ceiling, because injectWhenReady's own is 25 seconds of
   * boot plus a submit delay, and a caller holding an HTTP connection open for
   * that long with no way to know why is worse than a refusal it can retry.
   */
  readyTimeoutMs?: number
  wait: (ms: number) => Promise<void>
}

const DEFAULT_READY_TIMEOUT_MS = 30_000

/** The sentinel a cut race resolves with. Never a value any phase can produce. */
const CUT = Symbol('revoked')

export function makeCallRun(deps: CallRunDeps): (input: {
  workspaceId: string
  forkId: string
  prompt: string
  sub: string
  nodeId: string
}) => Promise<CallRunResult> {
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS

  return async ({ workspaceId, forkId, prompt, sub, nodeId }) => {
    const abort = new AbortController()
    let cut = false
    const revoked = new Promise<typeof CUT>((resolve) => {
      abort.signal.addEventListener('abort', () => resolve(CUT), { once: true })
    })

    // TAKEN BEFORE THE WAIT, not before the ask. The window this exists to
    // cover is precisely the one where the fork is booting and producing
    // nothing — an inferred liveness signal reads idle there, and the drain
    // would release the workspace under a call already accepted. It is also
    // the longest window in which a revoke can arrive, which is why the cut is
    // wired here rather than around the ask alone.
    const done = deps.inFlight({ workspaceId, sub, nodeId }, () => {
      cut = true
      abort.abort()
    })
    try {
      // THE RACE THIS CLOSES. A non-native fork is seeded by pasting a
      // PLAIN-TEXT REPLAY of the source's turns into it. askTerminal reports
      // what appeared after its own prompt, so an ask that starts while that
      // replay is still landing returns the replay — the owner's transcript,
      // to an internet caller, out of a path nobody wrote down. Waiting for
      // the injection to settle is what makes the reply diff mean what it says.
      const settled = await Promise.race([
        deps.ready(forkId).then(() => true),
        deps.wait(readyTimeoutMs).then(() => false),
        revoked
      ])
      if (settled === CUT || cut) return { ok: false, reason: 'revoked' }
      if (!settled) return { ok: false, reason: 'not_ready' }

      // Resolved AFTER the wait: a fork that was still booting when the call
      // arrived has a session by now, and one that died during it does not.
      const session = deps.sessionOf(forkId)
      if (session === undefined) return { ok: false, reason: 'not_running' }

      try {
        const raw = await Promise.race([deps.ask(session, prompt, abort.signal), revoked])
        // CHECKED AFTER THE AWAIT, not only before it. The agent's answer and
        // the owner's revoke can resolve in either order, and a reply that lost
        // the race by a millisecond is still a reply a revoked caller must not
        // receive. This is the security property: it does not depend on the
        // runner honouring the abort, only on this comparison.
        if (raw === CUT || cut) return { ok: false, reason: 'revoked' }
        // Contained on the way out — see call-reply.ts for why this protects
        // the CALLER as much as the owner.
        return { ok: true, ...safeCallReply(raw) }
      } catch {
        // askTerminal throws for producer refusals (another submission holds
        // the lease, a dispatch is mid-delivery, the input box is contaminated)
        // and for retirement and shutdown. All of them mean the same thing to a
        // caller — not now, try again — and the message is never echoed: it is
        // written for the owner's log and can name paths on this machine.
        //
        // Except when we cut it ourselves: an ask that throws BECAUSE it was
        // aborted is a revoke, and calling that 'busy' would invite the one
        // client behaviour a revoke exists to stop, which is retrying.
        return { ok: false, reason: cut ? 'revoked' : 'busy' }
      }
    } finally {
      done()
    }
  }
}
