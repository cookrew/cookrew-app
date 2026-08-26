/**
 * SCRUBBED ENV — Seatbelt confines the filesystem, this confines the secrets.
 *
 * Both, slice 1, and the reason they cannot be separated: a caller's Conductor
 * that has been prompt-injected does not need to read a file to steal the
 * owner's API key. It reads `process.env`. A sandbox with an inherited
 * environment is a locked door beside an open window.
 *
 * AN ALLOWLIST, NEVER A DENYLIST, and this is the whole design. A denylist is a
 * list of the secrets somebody thought of on the day they wrote it:
 * ANTHROPIC_API_KEY is on it, the next SDK's variable is not, and nothing fails
 * when a new one appears — it is simply inherited. An allowlist fails the other
 * way, which is the survivable direction: a harness that needs something it did
 * not get is a visible, immediate, fixable breakage.
 *
 * HOME POINTS AT THE SANDBOX, which does more work than it looks. It is what
 * stops a harness finding ~/.cookrew, ~/.aws, ~/.ssh, ~/.config or its own
 * credential file by the ordinary route, without enumerating any of them — the
 * same allowlist logic applied to the filesystem's own conventions. It also
 * makes the sandbox the natural place for the agent's state rather than a place
 * it has to be forced into.
 *
 * THE CONSEQUENCE, stated rather than discovered: a scrubbed env carries no
 * model credential, so a served session cannot run at all unless the owner
 * DELIBERATELY grants one. That is the right default — a stranger's prompts
 * must not silently spend the owner's tokens — and it means serving implies
 * lending a key, which is what makes the per-session budget load-bearing.
 */

/**
 * Variables a harness needs that carry nothing of the owner's.
 *
 * PATH is the one judgement call. It is required — a harness cannot exec
 * without it — and it names directories rather than secrets. It is also the
 * one an attacker would most like to control, so it is taken from the caller's
 * explicit input rather than inherited, and the session's own sandbox is never
 * prepended to it.
 */
const SAFE_KEYS = ['PATH', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TZ'] as const

export interface SessionEnvInput {
  /** The owner's environment — read, never forwarded wholesale. */
  parent: Readonly<Record<string, string | undefined>>
  /** Resolved sandbox. Becomes HOME and TMPDIR. */
  sandbox: string
  sessionId: string
  /**
   * Credentials the OWNER chose to lend this service, by name.
   *
   * Explicit and per-service: a key reaches a session because somebody decided
   * it should, never because it happened to be in the environment when the app
   * started. Values are read from `parent` so they are not stored a second
   * time, and a granted name that is absent is simply not set — a session with
   * no key fails visibly, which is better than one that half-works.
   */
  grantedKeys?: readonly string[]
}

/**
 * The environment a session's harness gets.
 *
 * Everything not named here is gone: not emptied, not masked — absent, so
 * `process.env.ANTHROPIC_API_KEY` is undefined rather than a decoy an injected
 * agent could still probe the shape of.
 */
export function sessionEnv(input: SessionEnvInput): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_KEYS) {
    const value = input.parent[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  // The sandbox is HOME. See the header — this is a whole class of secret
  // locations closed without naming any of them.
  env.HOME = input.sandbox
  env.TMPDIR = `${input.sandbox}/tmp`
  env.COOKREW_SESSION = input.sessionId
  // Marks the process as served, for anything downstream that must behave
  // differently for a stranger's agent. Read-only by convention; the real
  // boundaries are the profile and this allowlist, never this flag.
  env.COOKREW_SERVED = '1'

  for (const name of input.grantedKeys ?? []) {
    // A granted name still has to exist. Absent is left absent rather than set
    // to '' — an empty credential produces a confusing auth error where a
    // missing one produces an obvious "no key" error.
    const value = input.parent[name]
    if (typeof value === 'string' && value.length > 0) env[name] = value
  }
  return env
}

/**
 * Names that must never be grantable, whatever a config says.
 *
 * This is NOT the security boundary — the allowlist above is, and this file
 * would be safe with this function deleted. It exists because `grantedKeys` is
 * owner-configurable, and an owner who types HOME or PATH into it would punch
 * a hole through the two lines that close the most. A refusal here is a
 * misconfiguration caught at the moment it is made.
 */
export function grantable(name: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return false
  return !['HOME', 'PATH', 'TMPDIR', 'SHELL', 'COOKREW_SESSION', 'COOKREW_SERVED'].includes(name)
}
