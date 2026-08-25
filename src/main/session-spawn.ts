import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { confinedSpawn, seatbeltProfile, serviceRoot } from './session-sandbox'
import { grantable, sessionEnv } from './session-env'

/**
 * SCRUBBED-ENV-AT-SPAWN — the seam slice 1 built its primitives for.
 *
 * Slice 1 proved the profile (`seatbeltProfile`) and the env (`sessionEnv`) in
 * isolation; this composes them into the ONE transform a served terminal's
 * spawn must pass through: wrap the command under the Seatbelt profile AND
 * replace the environment with the scrubbed one. Both, together, because the
 * sandbox and the env close different windows — a profile confines the
 * filesystem, the env confines the secrets, and a prompt-injected agent that
 * cannot read a file can still read `process.env`. A spawn that got one without
 * the other is a locked door beside an open window.
 *
 * THE WRAP POINT is `ensureSession` — the process that becomes the agent's
 * parent — not the attach (session-sandbox.ts's header explains why). This
 * function produces the (file, args, env) that spawn point should use; where it
 * is called from PtyManager is the integration, and this seam is what it calls.
 *
 * PURE BUT FOR ONE WRITE. Everything here is a value except writing the profile
 * file, which `sandbox-exec -f` reads. That write is injected so the transform
 * is tested without disk, and it lands INSIDE the sandbox so END removes it with
 * everything else.
 *
 * THE INTEGRATION MUST MERGE, NOT REPLACE — AND IN THE RIGHT DIRECTION. The
 * returned `env` is an allowlist, so it omits the pane's own infrastructure
 * (`COOKREW_SOCKET`, `COOKREW_CLI`) that the in-pane CLI needs. `pty.ts` re-adds
 * those AFTER the scrub, as EXPLICIT keys: `{ ...servedSpawn.env, COOKREW_SOCKET,
 * COOKREW_CLI, ... }`. It must never spread `process.env` back over this — that
 * would pour the owner's environment back through the hole this just closed.
 */

/** A terminal's spawn as the pty layer would run it, before confinement. */
export interface RawSpawn {
  file: string
  args: readonly string[]
}

/** Everything the served transform needs about the session it spawns into. */
export interface ServedSpawnContext {
  /** The sessions root base (`~/.cookrew`). Sibling sessions live under it. */
  base: string
  serviceId: string
  sessionId: string
  /** The resolved sandbox dir (from `sandboxRoot`) — HOME, and the write root. */
  sandbox: string
  ownerEnv: Readonly<Record<string, string | undefined>>
  /** Names the owner lent this service; absent ones stay absent. */
  grantedKeys?: readonly string[]
}

/** A confined spawn: the wrapped command, the scrubbed env, and the profile it uses. */
export interface ServedSpawn {
  file: string
  args: string[]
  env: Record<string, string>
  /** Where the Seatbelt profile was written. */
  profilePath: string
}

/** Writes the profile `sandbox-exec -f` will read. Injected for testability. */
export type ProfileWriter = (profilePath: string, profile: string) => void

/** Per-process write sequence, so two spawns never share a temp path. */
let writeSeq = 0

/**
 * Write the profile ATOMICALLY — temp file then rename. Two terminals in one
 * session share a sandbox and so a profile path; a plain truncate-then-write
 * lets the second's `sandbox-exec -f` read a half-written file mid-write. The
 * content is deterministic in {sandbox, siblingRoot}, so both writers produce
 * identical bytes and the rename just makes the swap indivisible: a reader sees
 * a whole old profile or a whole new one, never a torn one that would fail to
 * parse and flake the spawn.
 */
const defaultWriter: ProfileWriter = (profilePath, profile) => {
  mkdirSync(path.dirname(profilePath), { recursive: true })
  const tmp = `${profilePath}.${writeSeq++}.tmp`
  writeFileSync(tmp, profile, { mode: 0o600 })
  renameSync(tmp, profilePath)
}

/**
 * Transform a raw terminal spawn into a confined, scrubbed one. The profile
 * denies the whole disk except this sandbox and re-allows this session's own
 * subtree beneath a sibling deny, so sessions are mutually invisible; the env
 * carries HOME→sandbox, the allowlist, and only the keys the owner lent. A spawn
 * that ran the returned (file, args, env) is a served agent that starts confined
 * and holds nothing of the owner's it was not given.
 */
export function servedSpawn(
  raw: RawSpawn,
  ctx: ServedSpawnContext,
  writeProfile: ProfileWriter = defaultWriter
): ServedSpawn {
  const siblingRoot = serviceRoot(ctx.base, ctx.serviceId)
  const profile = seatbeltProfile({ sandbox: ctx.sandbox, siblingRoot })
  // Inside the sandbox (so END's cleanup removes it); the per-session SANDBOX
  // dir is what keeps two sessions' profiles apart, not this constant filename.
  // REWRITTEN EVERY SPAWN, and that is load-bearing: the confined agent can
  // write inside its own sandbox, so it can overwrite this file — harmless while
  // running (sandbox-exec reads it once at exec) but it means any resume MUST
  // re-derive the profile through here, never trust an existing session.sb.
  const profilePath = path.join(ctx.sandbox, '.cookrew', 'session.sb')
  writeProfile(profilePath, profile)

  const wrapped = confinedSpawn(profilePath, raw.file, raw.args)
  // Filter the granted names through `grantable` HERE, not only upstream: the
  // grant loop in sessionEnv runs AFTER HOME/TMPDIR are set, so a granted HOME
  // or PATH would overwrite the sandbox scrub — the exact confinement this seam
  // exists to guarantee. A seam whose job is "holds nothing it wasn't given"
  // cannot depend on an unstated upstream check.
  const grantedKeys = (ctx.grantedKeys ?? []).filter(grantable)
  const env = sessionEnv({
    parent: ctx.ownerEnv,
    sandbox: ctx.sandbox,
    sessionId: ctx.sessionId,
    grantedKeys
  })
  return { file: wrapped.file, args: wrapped.args, env, profilePath }
}
