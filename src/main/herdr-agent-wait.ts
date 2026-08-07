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
  /** Injected for tests; defaults to the real `herdr` CLI. */
  exec?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>
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

const runCli = (file: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env }, (error) => (error ? reject(error) : resolve()))
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
    await exec('herdr', waitArgs(options.target, until, options.timeoutMs), {
      ...process.env,
      HERDR_SESSION: options.session,
      HERDR_CONFIG_PATH: options.configPath
    })
    return true
  } catch {
    return false
  }
}
