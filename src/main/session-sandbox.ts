import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * THE SANDBOX — cwd is not a jail, so this is the jail (SEC-S, slice 1).
 *
 * A working directory says where a process STARTS. It stops nothing: a child
 * that runs `cd ..` is outside it, and the ruling names that attack directly.
 * The mechanism here is macOS Seatbelt via sandbox-exec, and it was run before
 * it was proposed — a write inside the sandbox succeeds, `cd ../..` then write
 * is refused, and a write into ~/.cookrew is refused.
 *
 * WHERE IT ATTACHES, and this is the part that would have shipped wrong.
 * PtySession does not spawn the agent. It calls `ensureSession`, which CREATES
 * the tmux/herdr session the command runs in, and then `attachSpawn`, which
 * returns a command that merely ATTACHES to it. Wrapping the attach confines a
 * client while the agent stays a child of the owner's unconfined, shared
 * multiplexer server. So the profile wraps ensureSession — the process that
 * actually becomes the agent's parent.
 *
 * TWO CAVEATS THAT BELONG AT THE CALL SITE RATHER THAN IN A DESIGN NOTE:
 *
 *   SYMLINKED ROOTS SILENTLY VOID THE PROFILE. A profile written against
 *   /tmp/… blocks everything INCLUDING the sandbox, because macOS resolves
 *   /tmp → /private/tmp and `subpath` matches after resolution. It does not
 *   fail loudly; it fails as "the agent cannot write anywhere", which reads as
 *   a broken agent rather than a broken rule. Every path here is
 *   realpath-resolved before it reaches a profile, and `sandboxRoot` creates
 *   the directory first precisely so it CAN be resolved.
 *
 *   sandbox-exec IS DEPRECATED AND PRESENT. Apple has marked it deprecated for
 *   years while shipping it, and it remains the only per-child filesystem
 *   confinement available to an unprivileged app on macOS. It is the right
 *   choice today and the wrong thing to have only one of, so the profile is
 *   produced behind this seam and the spawn wrapper is one function.
 *
 * WHAT THIS DOES NOT BUY, stated here so nobody has to infer it. The profile
 * allows file-read*: the toolchain (node, git, the harness binary and their
 * libraries) reads from all over the filesystem, and denying that means
 * enumerating every path it touches — brittle in the direction that breaks the
 * agent. So slice 1 is a WRITE boundary plus cross-session read denial. A
 * caller's agent cannot write outside its sandbox and cannot read another
 * session's; it CAN read the owner's files. The caller-facing copy must not
 * claim otherwise.
 */

/** Where every session sandbox for one service lives. */
export function serviceRoot(base: string, serviceId: string): string {
  return path.join(base, 'sessions', safeSegment(serviceId))
}

/**
 * A path segment that cannot climb, hide or collide.
 *
 * Ids reach this from the wire (a service id, an account id), so `..`, a
 * leading dot and separators are all refused rather than escaped — the same
 * closed default PresetStore.dirFor uses. Lowercased because macOS is
 * case-insensitive: `Ana` and `ana` are one directory, and two accounts that
 * differ only in case must not silently share a sandbox.
 */
export function safeSegment(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'unnamed'
}

/**
 * The DIRECTORY segment for one session, shortened.
 *
 * A sessionId carries its serviceId as a prefix (`svc-x-ana-1`), and repeating
 * that prefix under the service's own directory pushed real paths past
 * sun_path (104 bytes on macOS): claude inside a minted pane died at boot with
 * "local socket name length exceeds capacity of sun_path" — observed live, and
 * silent from the caller's side but for a garbled reply. The service directory
 * already names the service, so the segment keeps only what remains.
 *
 * EVERY lexical constructor of a session path must use this (sandboxRoot, the
 * Ender's dirFor, the turn/annotation dirs) — a second spelling of the rule is
 * how a cleanup deletes the wrong directory.
 */
export function sessionSegment(serviceId: string, sessionId: string): string {
  const service = safeSegment(serviceId)
  const session = safeSegment(sessionId)
  return session.startsWith(`${service}-`) ? session.slice(service.length + 1) : session
}

/**
 * Create and resolve a session's sandbox directory.
 *
 * Created BEFORE resolving, because realpathSync throws on a path that does not
 * exist and the resolved form is what every later check compares against. The
 * returned value is the only one that may be stored.
 */
export function sandboxRoot(base: string, serviceId: string, sessionId: string): string {
  const dir = path.join(serviceRoot(base, serviceId), sessionSegment(serviceId, sessionId))
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

/**
 * Is `candidate` inside this sandbox? Returns the resolved path, or null.
 *
 * A FUNCTION, not a convention. "We always pass the sandbox dir" is the kind of
 * guarantee this program keeps finding to be decorative; a call that must
 * consult this cannot forget to.
 *
 * The equality case is allowed (the sandbox itself is inside itself) and the
 * prefix test carries the separator, so `/s/ana-1-evil` is not inside
 * `/s/ana-1` — a string prefix without it is the classic near-miss.
 */
export function confine(sandbox: string, candidate: string): string | null {
  const root = path.resolve(sandbox)
  const target = path.resolve(root, candidate)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

/**
 * Resolve symlinks before confining, for paths that already exist.
 *
 * `confine` is lexical and cannot see a symlink pointing out of the sandbox.
 * Anything that exists is resolved first; anything that does not is confined
 * lexically, which is correct because it cannot be a link yet — and the
 * directory it lands in was itself confined.
 */
export function confineExisting(sandbox: string, candidate: string): string | null {
  const lexical = confine(sandbox, candidate)
  if (lexical === null) return null
  let real: string
  try {
    real = realpathSync(lexical)
  } catch {
    return lexical
  }
  return confine(sandbox, real)
}

export interface ProfileInput {
  /** Resolved, existing sandbox for THIS session. */
  sandbox: string
  /** Resolved service root — every sibling session lives under it. */
  siblingRoot: string
  /**
   * Every session sandbox on the machine (`<base>/sessions`). Denied whole, so
   * a service cannot read ANOTHER service's sessions — the sibling deny below
   * only ever covered its own, and a live probe confirmed the gap.
   */
  sessionsRoot: string
  /**
   * The owner's credential stores, denied outright. Required rather than
   * optional: this is the list that makes the per-service grant mean something,
   * and a call site that forgot it would silently hand every served agent the
   * owner's refresh token. See owner-secrets.ts for why it is a denylist.
   */
  secretPaths: readonly string[]
  /**
   * The app's CLI control-plane socket (PtyManager.socketPath), denied so a
   * served agent cannot drive the owner's canvas. The env keys that name it
   * are already withheld from served panes (pty.ts) — this is the second lock,
   * because the path is also written to ~/.cookrew/socket and a determined
   * process could simply read it there.
   */
  controlSocketPath?: string
}

/**
 * The Seatbelt profile for one session.
 *
 * Deny-by-default, then the narrowest set that lets a harness run. The two
 * lines that matter are the write subpath (this sandbox and nothing else) and
 * the sibling deny, which is what makes sessions mutually invisible — cheap
 * here because it is one stable path, unlike denying the owner's whole disk.
 *
 * The sibling deny is placed AFTER the read allow deliberately: Seatbelt takes
 * the last matching rule, so a deny written above the allow would be silently
 * overridden. That ordering is the whole enforcement.
 */
export function seatbeltProfile(input: ProfileInput): string {
  const sandbox = quote(input.sandbox)
  const siblings = quote(input.siblingRoot)
  const sessions = quote(input.sessionsRoot)
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork signal)',
    '(allow sysctl-read mach-lookup mach-priv-task-port)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${sandbox}))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
    // The pane is a PTY and an interactive harness NEEDS its terminal:
    // setRawMode is an ioctl on the controlling tty, and without these an
    // interactive pi died at boot with EPERM (InteractiveMode.run) before
    // writing a single session record — the served crew answered nothing,
    // ever, and the caller's ask 500'd as "no file-backed agent turn"
    // (2026-08-27, the last broken link of the serve-a-session line).
    // Device nodes only; no filesystem reach.
    '(allow file-read* file-write* file-ioctl (regex #"^/dev/ttys[0-9]+$") (literal "/dev/tty") (literal "/dev/ptmx"))',
    '(allow network*)',
    // LAST WINS, and the ordering below IS the enforcement — a deny written
    // above the blanket read allow would be silently overridden.
    //
    // EVERY session, not just the siblings. This denied `siblingRoot` alone,
    // which is one service's sessions; a probe run against the real profile
    // read another service's sandbox straight out. One subpath covers both, and
    // this session's own subtree is re-allowed last because it lives inside it.
    `(deny file-read* (subpath ${sessions}))`,
    // The owner's credential stores. `file-read*` is allowed across the disk on
    // purpose (denying it means enumerating everything a toolchain touches), so
    // without these lines a served agent could read the owner's OAuth refresh
    // token without being lent anything — see owner-secrets.ts. Both filters:
    // `subpath` catches a directory, `literal` a single file.
    ...input.secretPaths.map(
      (secret) => `(deny file-read* (subpath ${quote(secret)}) (literal ${quote(secret)}))`
    ),
    // The CLI socket. `(allow network*)` above covers unix-domain connects, so
    // without this a served agent that learned the path could speak to the
    // app's command socket — which takes orders with no credential and accepts
    // `--as <any agent>`. Denying the connect closes that from the other side.
    ...(input.controlSocketPath
      ? [
          `(deny network-outbound (literal ${quote(input.controlSocketPath)}))`,
          `(deny file-read* file-write* (literal ${quote(input.controlSocketPath)}))`
        ]
      : []),
    // TRAVERSAL. Found by running it: denying the service root outright made a
    // session unable to reach its OWN sandbox — `cd` into it failed with "Not a
    // directory", because reaching a child means traversing the parent. The
    // metadata allows are LITERALS, so those directory nodes can be walked
    // through while their other children stay unreadable. A subpath allow here
    // would have re-opened every sibling.
    `(allow file-read-metadata (literal ${sessions}))`,
    `(allow file-read-metadata (literal ${siblings}))`,
    `(allow file-read* (subpath ${sandbox}))`
  ].join('\n')
}

/** Seatbelt string literals — a quote in a path would end the s-expression. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Wrap a command so it runs under the profile.
 *
 * Returns the file+args a spawner should use. Applied at `ensureSession` — see
 * the header for why the attach is the wrong place.
 */
export function confinedSpawn(
  profilePath: string,
  file: string,
  args: readonly string[]
): { file: string; args: string[] } {
  return { file: '/usr/bin/sandbox-exec', args: ['-f', profilePath, file, ...args] }
}
