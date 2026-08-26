import path from 'node:path'
import { homedir } from 'node:os'

/**
 * WHERE THE OWNER'S CREDENTIALS LIVE — the paths a served session may not read.
 *
 * THIS IS A DENYLIST AND THAT IS A DEMOTION, not a design. session-env.ts
 * argues the case against denylists and it is right: a list of the secrets
 * somebody thought of on the day they wrote it grows stale silently. It exists
 * anyway because the Seatbelt profile allows `file-read*` across the whole
 * disk — deliberately, since denying everything means enumerating every path a
 * toolchain touches — and a blanket read allow makes the per-service grant
 * DECORATIVE. Measured, not assumed, with the real profile:
 *
 *   owner claude credentials: READABLE
 *   another service sandbox:  READABLE
 *
 * A caller's agent could read `~/.claude/.credentials.json` — an OAuth refresh
 * token, which is an account rather than a key — without the owner lending
 * anything. So "the owner lends keys on purpose or not at all" was not true of
 * the filesystem, only of the environment.
 *
 * WHAT ACTUALLY CLOSES THIS is HOME pointing at the sandbox, which is why these
 * paths are reachable only by a process that goes looking with an absolute
 * path. This list catches the one that goes looking. Treat a new entry as a
 * patch, not as the mechanism.
 */

/**
 * Every session sandbox on the machine, so no service can read another's.
 *
 * The profile denied SIBLINGS — sessions of the same service — and left every
 * other service's sandbox readable, which the probe above confirms. One
 * subpath covers both, and the session's own sandbox is re-allowed after it.
 */
export function sessionsRootOf(base: string): string {
  return path.join(base, 'sessions')
}

/**
 * Credential stores under the owner's home.
 *
 * `.claude/.credentials.json` rather than `.claude`: the directory also holds
 * settings and plugins a harness legitimately reads, and denying the whole tree
 * breaks the agent in a way that reads as our bug. The rest are directories
 * whose entire purpose is secrets.
 */
export function ownerSecretPaths(base: string, home: string = homedir()): readonly string[] {
  const at = (...parts: string[]): string => path.join(home, ...parts)
  return [
    // The one the ruling names by hand.
    at('.claude', '.credentials.json'),
    at('.claude.json'),
    at('.ssh'),
    at('.aws'),
    at('.gnupg'),
    at('.netrc'),
    at('.npmrc'),
    at('.pypirc'),
    at('.docker', 'config.json'),
    at('.kube'),
    at('.config', 'gh'),
    at('.config', 'gcloud'),
    // Cookrew's own: the hosted-Sous key and the env files a grant lends FROM.
    // A granted copy lands inside the sandbox and stays readable; the original
    // is what a service that was lent nothing must not be able to go and take.
    path.join(base, 'sous.json'),
    path.join(base, 'qwen.env')
  ]
}
