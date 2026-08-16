// "Has the agent finished?" — asked, instead of inferred.
//
// WHAT THIS RETIRES
// -----------------
// `cookrew ask` has always answered that question with output quiescence:
// poll every 200ms until the PTY has been silent for 2500ms. That heuristic is
// wrong in both directions, and both failures are routine rather than exotic:
//
//   too early — an agent that pauses mid-turn (a long tool call, a slow model)
//               is silent for 2.5s and gets reported as finished
//   too late  — an agent that finished instantly still costs 2.5s of waiting,
//               on every single ask
//
// herdr already tracks agent lifecycle for the panes it hosts, and `agent wait`
// blocks until the agent actually reaches a requested state. Measured at ~10ms
// against a real agent, versus the 2500ms floor the heuristic cannot go below.
//
// WHY THIS IS NOT ON THE Multiplexer INTERFACE'S SYNC PATH
// --------------------------------------------------------
// That interface is synchronous, and `agent wait` blocks until the state is
// reached — up to the ask timeout, which is ten minutes. Running it through
// execFileSync would freeze Electron's main process for that long: no
// rendering, no IPC, no other agent. So the sync CLI path stays for the
// Multiplexer's cheap reads, and waiting gets its own async door.

import { execFile } from 'node:child_process'

/** Agent lifecycle states herdr reports. */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface WaitOptions {
  /** Cookrew's herdr session — the isolation boundary. */
  session: string
  configPath: string
  /** Pane id or agent name. */
  target: string
  /** States that end the wait. */
  until?: HerdrAgentStatus[]
  timeoutMs: number
  /**
   * The abort seam (Sol r8 P1). Threaded into execFile, which TERM-kills the
   * CLI child when the signal fires — a retired terminal, a backend death or
   * an interrupted dispatch must not leave `herdr agent prompt --wait`
   * children (pipes, callbacks, promises) alive for the full caller timeout.
   * The settled promise rejects; callers already classify that rejection
   * under their own liveness checks, so a late abort changes no state.
   */
  signal?: AbortSignal
  /** Injected for tests; defaults to the real `herdr` CLI. */
  exec?: (
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ) => Promise<void>
}

/** Arguments for `herdr agent wait`, extracted so they are testable alone. */
export function waitArgs(target: string, until: HerdrAgentStatus[], timeoutMs: number): string[] {
  return [
    'agent',
    'wait',
    target,
    ...until.flatMap((state) => ['--until', state]),
    '--timeout',
    String(timeoutMs)
  ]
}

/**
 * Arguments for `herdr agent prompt --wait`: submit AND block until the agent
 * stops working, in one herdr call. The prompt rides as a single argv element,
 * so no shell quoting hazard exists no matter what the text contains.
 *
 * The default `until` matches waitForAgentState: blocked counts as done —
 * an agent stuck on a permission prompt has stopped producing an answer, and
 * the caller needs to hear that rather than wait out the full timeout.
 */
export function promptArgs(target: string, prompt: string, timeoutMs: number): string[] {
  return [
    'agent',
    'prompt',
    target,
    prompt,
    '--wait',
    '--until', 'idle',
    '--until', 'done',
    '--until', 'blocked',
    '--timeout',
    String(timeoutMs)
  ]
}

/**
 * Arguments for `herdr agent prompt` WITHOUT `--wait`: submit and return at
 * SUBMISSION ACKNOWLEDGEMENT, not at turn completion (Sol r8 P1 — the lease
 * split). Measured against the CLI: without `--wait` the command exits as
 * soon as herdr has typed the prompt into the pane, which is exactly the
 * bytes-in-flight window the producer lease guards. A caller that only needs
 * the lease window uses this and runs its reply-wait (agent wait / output
 * quiescence) OUTSIDE the lease, so owner input is refused for milliseconds
 * instead of the whole turn. `--timeout` still rides along to bound the CLI
 * call itself.
 */
export function submitArgs(target: string, prompt: string, timeoutMs: number): string[] {
  return ['agent', 'prompt', target, prompt, '--timeout', String(timeoutMs)]
}

/**
 * What happened to a prompt handed to herdr. The three-way split is the
 * safety contract, measured the hard way:
 *
 *   'done'      — submitted AND the agent finished; the reply is on screen.
 *   'submitted' — herdr delivered the prompt but could not observe the
 *                 outcome: its detector saw no state change
 *                 (agent_prompt_stalled), or the wait expired while the agent
 *                 was still working. The prompt IS in the pane. Typing it
 *                 again double-submits — observed live as a queued duplicate
 *                 in the agent's input box — so the caller must WAIT, never
 *                 retype.
 *   'failed'    — herdr never delivered it (unresolvable agent, server
 *                 down). Typing is the correct fallback.
 */
export type PromptOutcome = 'done' | 'submitted' | 'failed'

/** Submit a prompt via herdr and wait for the agent to finish. */
export async function promptViaHerdr(
  options: WaitOptions & { prompt: string }
): Promise<PromptOutcome> {
  const exec = options.exec ?? runCli
  try {
    await exec(
      'herdr',
      promptArgs(options.target, options.prompt, options.timeoutMs),
      {
        ...process.env,
        HERDR_SESSION: options.session,
        HERDR_CONFIG_PATH: options.configPath
      },
      options.signal
    )
    return 'done'
  } catch (error) {
    // A TIMEOUT is 'submitted', not 'failed'. `agent prompt --wait` submits and
    // THEN waits, so when the wait expires the prompt is in the pane and the
    // agent is very likely still answering — the only thing that timed out is
    // our patience. Mapping it to 'failed' told the caller "it never went out"
    // and every turn longer than the timeout got a second copy of the brief.
    if (isStall(error) || isTimeout(error)) return 'submitted'
    return 'failed'
  }
}

/**
 * Submit a prompt via herdr and return at SUBMISSION ACKNOWLEDGEMENT — the
 * two-state little sibling of promptViaHerdr, for callers that hold the
 * producer lease only across the bytes-in-flight window (Sol r8 P1).
 *
 *   'submitted' — herdr accepted the prompt (exit 0), OR the outcome is
 *                 ambiguous (stall envelope, killed child, timeout): the
 *                 prompt may well be in the pane, and the do-not-retype rule
 *                 applies exactly as in promptViaHerdr — the caller waits it
 *                 out rather than re-sending.
 *   'failed'    — herdr positively refused (unresolvable agent, server
 *                 down): nothing went out, and the typed path is the correct
 *                 fallback.
 */
export async function submitViaHerdr(
  options: WaitOptions & { prompt: string }
): Promise<'submitted' | 'failed'> {
  const exec = options.exec ?? runCli
  try {
    await exec(
      'herdr',
      submitArgs(options.target, options.prompt, options.timeoutMs),
      {
        ...process.env,
        HERDR_SESSION: options.session,
        HERDR_CONFIG_PATH: options.configPath
      },
      options.signal
    )
    return 'submitted'
  } catch (error) {
    if (isStall(error) || isTimeout(error)) return 'submitted'
    return 'failed'
  }
}

/**
 * A stall error means the prompt LANDED — herdr's own words: "agent prompt
 * produced no observed state change". The marker is searched in everything
 * the process said, because herdr prints the error envelope to stdout and
 * exec errors carry both streams.
 */
export function isStall(error: unknown): boolean {
  const e = error as { message?: string; stdout?: unknown; stderr?: unknown }
  const text = `${e?.message ?? ''} ${String(e?.stdout ?? '')} ${String(e?.stderr ?? '')}`
  return text.includes('agent_prompt_stalled')
}

/**
 * Did the WAIT expire rather than the submission fail?
 *
 * herdr reports it as an `agent_wait_timeout` envelope; a killed child process
 * reports it as ETIMEDOUT. Both mean the same thing here — the prompt was
 * handed over and the outcome is simply unobserved — and both must be kept
 * away from the retry path.
 */
export function isTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; stdout?: unknown; stderr?: unknown }
  if (e?.code === 'ETIMEDOUT') return true
  const text = `${String(e?.message ?? '')} ${String(e?.stdout ?? '')} ${String(e?.stderr ?? '')}`
  return /agent_wait_timeout|\btimed?[ _-]?out\b/i.test(text)
}

const runCli = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> =>
  new Promise((resolve, reject) => {
    // `signal` is execFile's own abort seam: firing it TERM-kills the child
    // and settles the callback with an AbortError — the CLI process, its
    // pipes and this promise all end NOW instead of at the caller timeout.
    execFile(file, args, { env, ...(signal !== undefined ? { signal } : {}) }, (error) =>
      error ? reject(error) : resolve()
    )
  })

/**
 * Block until the agent reaches one of `until`, or the timeout expires.
 *
 * Resolves TRUE when herdr reported the state and FALSE when it did not —
 * a timeout, a pane herdr does not know, or herdr being unreachable. False is
 * a real answer here, not an error: callers fall back to the quiescence
 * heuristic, which is exactly what they did before this existed. Throwing
 * would turn a degraded signal into a failed `cookrew ask`.
 */
export async function waitForAgentState(options: WaitOptions): Promise<boolean> {
  const until = options.until ?? ['idle', 'done', 'blocked']
  const exec = options.exec ?? runCli
  try {
    await exec(
      'herdr',
      waitArgs(options.target, until, options.timeoutMs),
      {
        ...process.env,
        HERDR_SESSION: options.session,
        HERDR_CONFIG_PATH: options.configPath
      },
      options.signal
    )
    return true
  } catch {
    return false
  }
}
