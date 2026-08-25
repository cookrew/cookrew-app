import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { confinedSpawn, seatbeltProfile, serviceRoot } from './session-sandbox'
import { sessionEnv } from './session-env'

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

const defaultWriter: ProfileWriter = (profilePath, profile) => {
  mkdirSync(path.dirname(profilePath), { recursive: true })
  writeFileSync(profilePath, profile, { mode: 0o600 })
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
  // Inside the sandbox, so END's cleanup removes it. Named per session so two
  // sessions never share a profile file.
  const profilePath = path.join(ctx.sandbox, '.cookrew', 'session.sb')
  writeProfile(profilePath, profile)

  const wrapped = confinedSpawn(profilePath, raw.file, raw.args)
  const env = sessionEnv({
    parent: ctx.ownerEnv,
    sandbox: ctx.sandbox,
    sessionId: ctx.sessionId,
    grantedKeys: ctx.grantedKeys
  })
  return { file: wrapped.file, args: wrapped.args, env, profilePath }
}
