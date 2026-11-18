import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { confinedSpawn, safeSegment, seatbeltProfile, serviceRoot, sessionSegment } from './session-sandbox'
import { grantable, sessionEnv } from './session-env'
import { ownerSecretPaths, sessionsRootOf } from './owner-secrets'

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
 * is tested without disk. It lands OUTSIDE the sandbox (seatProfilePath), where
 * the seat cannot swap it before the next spawn reads it.
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
  /** The app's CLI command socket, denied in the profile. See seatbeltProfile. */
  controlSocketPath?: string
  /** The gateway's port(s) the seat must not reach (session-sandbox.ts, sandbox-deny.ts). */
  gatewayPorts?: readonly number[]
  /** Loopback ports the owner lent this service (service-grants.ts); every other one is denied. */
  loopbackPorts?: readonly number[]
}

/** A confined spawn: the wrapped command, the scrubbed env, and the profile it uses. */
export interface ServedSpawn {
  file: string
  args: string[]
  env: Record<string, string>
  /** Where the Seatbelt profile was written. */
  profilePath: string
}

/** The env + written profile a served spawn needs, without wrapping a command. */
export interface ServedConfinement {
  env: Record<string, string>
  /** The written Seatbelt profile the spawn should be wrapped under. */
  profilePath: string
  /** What the profile said, hashed: a seat keeps this profile until it is respawned (seat-ledger.ts). */
  profileDigest: string
}

/** Where a session's profile is written: `<base>/seat-profiles/<service>/<session>.sb`, never in a sandbox. */
export function seatProfilePath(ctx: Pick<ServedSpawnContext, 'base' | 'serviceId' | 'sessionId'>): string {
  return path.join(ctx.base, 'seat-profiles', safeSegment(ctx.serviceId), `${sessionSegment(ctx.serviceId, ctx.sessionId)}.sb`)
}

/** A short, stable hash of a profile's text. */
export function profileDigest(profile: string): string {
  return createHash('sha256').update(profile).digest('hex').slice(0, 16)
}

/**
 * How a terminal spawns, decided BEFORE anything runs. A served workspace whose
 * context is gone (a restart empties the in-memory map; the workspace keeps its
 * served mark on disk) must not fall through to the owner's unconfined spawn:
 * that would run a stranger's conversation as the owner. It is refused.
 */
export function spawnMode(servedWorkspace: boolean, hasContext: boolean): 'owner' | 'confined' | 'refuse' {
  if (hasContext) return 'confined'
  return servedWorkspace ? 'refuse' : 'owner'
}

/**
 * Is this folder inside the sessions root? A served workspace forked before
 * its served mark was written to disk (the mark arrived 2026-11-16) has no
 * mark to keep across a restart, but its terminals still live in a sandbox
 * under `<base>/sessions`. The folder says so when the mark cannot: such a
 * terminal is refused, never spawned as the owner. POSIX on purpose: these are
 * macOS paths wherever the check runs.
 */
export function inSessionsRoot(cwd: string, sessionsRoot: string): boolean {
  const at = path.posix.normalize(cwd)
  const root = path.posix.normalize(sessionsRoot).replace(/\/+$/, '')
  return at === root || at.startsWith(`${root}/`)
}

/** The profile a served spawn runs under, as text: pure, so a gate can ask what it would be now. */
export function servedProfile(ctx: ServedSpawnContext): string {
  return seatbeltProfile({
    sandbox: ctx.sandbox,
    siblingRoot: serviceRoot(ctx.base, ctx.serviceId),
    sessionsRoot: sessionsRootOf(ctx.base),
    // What the owner did NOT lend, made unreachable. Without this the grant in
    // service-grants.ts is a formality — the agent could read the originals.
    secretPaths: ownerSecretPaths(ctx.base),
    // The owner's canvas control plane, denied from the other side of the env.
    ...(ctx.controlSocketPath ? { controlSocketPath: ctx.controlSocketPath } : {}),
    ...(ctx.gatewayPorts ? { gatewayPorts: ctx.gatewayPorts } : {}),
    ...(ctx.loopbackPorts ? { loopbackAllow: ctx.loopbackPorts } : {})
  })
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
export function servedConfinement(
  ctx: ServedSpawnContext,
  writeProfile: ProfileWriter = defaultWriter
): ServedConfinement {
  const profile = servedProfile(ctx)
  // OUTSIDE THE SANDBOX, in a directory only the app writes. sandbox-exec reads
  // the profile by path a few milliseconds after this write, and a live seat
  // process can write anywhere in its own sandbox: with the file in there it
  // renamed its own `(allow default)` into place in that gap, and the respawn
  // ran unconfined (security review 2026-11-18, 19 of 20;
  // tests/served-profile-swap.test.ts). Here the seat can neither write nor
  // rename. One file per session (sessionSegment, the rule every session path
  // uses), REWRITTEN EVERY SPAWN: a resume re-derives it, never trusts it.
  const profilePath = seatProfilePath(ctx)
  writeProfile(profilePath, profile)

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
  // Pi treats an explicit agent directory as host-managed configuration and
  // skips its interactive first-run theme/analytics wizard. The directory is
  // inside HOME and is also where explicit provider-file grants land.
  env.PI_CODING_AGENT_DIR = path.join(ctx.sandbox, '.pi', 'agent')
  return { env, profilePath, profileDigest: profileDigest(profile) }
}

export function servedSpawn(
  raw: RawSpawn,
  ctx: ServedSpawnContext,
  writeProfile: ProfileWriter = defaultWriter
): ServedSpawn {
  const { env, profilePath } = servedConfinement(ctx, writeProfile)
  const wrapped = confinedSpawn(profilePath, raw.file, raw.args)
  return { file: wrapped.file, args: wrapped.args, env, profilePath }
}
