/**
 * Types for src/shared/pane-agent.mjs, so the TypeScript side (the oracle,
 * the tests) type-checks against the SAME module the plain-node gate script
 * imports. Written by hand next to the implementation, the way
 * scripts/perf-eval-lib.d.mts is.
 */

/** A live claude process, as ~/.claude/sessions/<pid>.json records it. */
export interface PaneHolder {
  pid: number
  sessionId: string
  /** 'bg' for a background agent/spare, 'interactive' for a real terminal. */
  kind: string
  cwd?: string | null
}

export interface PaneAgent {
  pid: number
  sessionId: string
}

export interface PaneAgentResolution {
  /** The pane's agent, or null when it could not be determined. */
  agent: PaneAgent | null
  /** Why it could not be determined — printed instead of an alarm. */
  reason: string | null
}

export declare const SESSION_UUID_RE: RegExp
export declare function isSessionUuid(id: unknown): boolean
export declare function isPaneAgent(
  holder: PaneHolder | null | undefined,
  cwd: string,
  real?: (dir: string) => string
): boolean
export declare function paneAgentOf(
  panePid: number | null | undefined,
  holders: readonly PaneHolder[],
  cwd: string,
  real?: (dir: string) => string
): PaneAgent | null
export declare function withoutDescendantsOfPeers(
  holders: readonly PaneHolder[],
  ppidOf: (pid: number) => number | null
): PaneHolder[]
export declare function resolvePaneAgent(input: {
  panePid?: number | null
  holders?: readonly PaneHolder[]
  cwd: string
  real?: (dir: string) => string
}): PaneAgentResolution
