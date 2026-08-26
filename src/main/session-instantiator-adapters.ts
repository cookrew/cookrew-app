import path from 'node:path'
import { sandboxRoot, serviceRoot, sessionSegment } from './session-sandbox'
import type {
  ConductorRoute,
  Ender,
  InstantiatorDeps,
  Minter,
  TemplateSource
} from './session-instantiator'

/**
 * WIRING — the four seams, built from the real subsystems (slice 3).
 *
 * The orchestrator (session-instantiator.ts) decides; these connect it to the
 * machinery R30 composes. Each adapter takes a NARROW handle — the smallest
 * slice of the real subsystem it needs — rather than the subsystem itself, so
 * the adapter compiles and is tested here, and index.ts supplies the concrete
 * `forkTeam` / `TeamStore` / `CallsInFlight` / node lookups at mount. The narrow
 * handle IS the contract index.ts must satisfy, written down as a type instead
 * of discovered at the call site.
 *
 * Everything with security weight already lives behind slice 1's functions
 * (`sandboxRoot`, `sessionEnv`); these adapters only route to them.
 */

// ── TemplateSource ───────────────────────────────────────────────────────────

/** The one method the template read needs from `TeamStore`. */
export interface TeamLoad {
  load(templateId: string): unknown
}

/**
 * The pin resolved for a template: its version LABEL and its content-address
 * (design S1c). Read ONCE at mint, so a running session cannot drift.
 */
export interface PinResolver {
  resolve(templateId: string): { version: number; pinAddress: string }
}

/**
 * Read the LOCAL template a service serves, resolved to its pin. Local-first is
 * not a fallback (S1b): the crew runs on this machine, so a service serves what
 * this machine holds. A template the owner has not materialised here is one this
 * machine cannot run, and that surfaces as a refusal, not a silent empty mint.
 */
export function makeTemplateSource(
  templateIdOf: (serviceId: string) => string,
  teams: TeamLoad,
  pins: PinResolver
): TemplateSource {
  return {
    read(serviceId) {
      const templateId = templateIdOf(serviceId)
      if (teams.load(templateId) === undefined) {
        throw new Error(`served template '${templateId}' is not on this machine`)
      }
      const { version, pinAddress } = pins.resolve(templateId)
      return { templateId, version, pinAddress }
    }
  }
}

// ── Minter ───────────────────────────────────────────────────────────────────

/**
 * The narrow slice of `forkTeam` the mint needs: create a NEW workspace from a
 * saved template, rooted at `dir`, with `env`, booted IN PLACE (slice 1's
 * `bootTerminals`, never `switchWorkspace` — a served session must not yank the
 * owner's screen). Returns the new workspace id. index.ts wraps `forkTeam`
 * (with `worktree` and native-session restore) to satisfy this.
 */
export interface ForkEngine {
  fork(input: {
    name: string
    templateId: string
    dir: string
    serviceId: string
    sessionId: string
  }): Promise<string>
}

/**
 * Lay the owner's per-service grant down inside a fresh sandbox and spend one
 * session of its budget. A narrow handle over `ServiceGrants.provision` — the
 * adapter must not learn what a credential is.
 */
export interface SessionProvisioner {
  provision(serviceId: string, sandbox: string): void
}

/**
 * Mint a sandboxed session. Create and resolve the sandbox dir FIRST (slice 1's
 * `sandboxRoot` realpaths it, so a Seatbelt profile written for it matches after
 * macOS resolves `/tmp` → `/private`), then fork the template rooted there. The
 * scrubbed ENV is NOT applied here — it is applied when each served terminal
 * spawns (`servedConfinement`, via the boot the fork engine drives), because
 * that is the moment the env reaches a process; minting only lays down the dir
 * the spawn confines into.
 */
export function makeMinter(config: {
  base: string
  engine: ForkEngine
  /**
   * Remove the sandbox if the fork fails. Symmetric with the orchestrator's
   * ordinal rollback: a mint that throws leaves NOTHING behind — no consumed
   * ordinal, no orphaned dir. Optional so a test can omit it; index.ts supplies
   * the same `rm -rf` remover the Ender uses.
   */
  remover?: SandboxRemover
  /**
   * Put what the owner LENT this service into the sandbox, and spend one of the
   * grant's sessions (R30 G2). Runs after the dir exists and before the fork,
   * because a harness reads its config at boot and the fork is what boots it.
   *
   * Throwing is how an exhausted budget stops a mint: the rollback below is
   * already the path for "this session must leave nothing behind", so an
   * over-budget mint reuses it rather than inventing a second cleanup.
   */
  provision?: SessionProvisioner
}): Minter {
  return {
    async mint({ serviceId, identity, template }) {
      const sandbox = sandboxRoot(config.base, serviceId, identity.sessionId)
      try {
        config.provision?.provision(serviceId, sandbox)
        return await config.engine.fork({
          name: identity.workspaceName,
          templateId: template.templateId,
          dir: sandbox,
          serviceId,
          sessionId: identity.sessionId
        })
      } catch (err) {
        config.remover?.remove(sandbox)
        throw err
      }
    }
  }
}

// ── ConductorRoute ───────────────────────────────────────────────────────────

/** The one lookup routing needs: the entry/orch terminal of a live workspace. */
export interface EntryTerminalLookup {
  entryTerminalOf(workspaceId: string): string | null
}

/**
 * Only the orch answers (design S5). index.ts satisfies `entryTerminalOf` with
 * `entryAgentOf` over the workspace's LIVE nodes — never a snapshot, and never
 * the focused canvas's, so a served session's door is its own.
 */
export function makeConductorRoute(lookup: EntryTerminalLookup): ConductorRoute {
  return { conductorOf: (workspaceId) => lookup.entryTerminalOf(workspaceId) }
}

// ── Ender ────────────────────────────────────────────────────────────────────

/** The revoke seam: cut every call matching a predicate, return the count. */
export interface CallCutter {
  cancelWhere(match: (identity: { workspaceId: string }) => boolean): number
}

/** Remove a sandbox directory. `rm -rf` semantics — absence is not an error. */
export interface SandboxRemover {
  remove(dir: string): void
}

/**
 * END (design S4). `cut` reuses `CallsInFlight.cancelWhere`, matching every call
 * in the session's workspace — not a second cancellation path. `cleanup` removes
 * the sandbox by the same LEXICAL construction `sandboxRoot` used
 * (`serviceRoot` + `safeSegment`), built purely here so removing a path never
 * first re-creates it. `sandboxRoot` additionally realpaths its result, so on a
 * base under a symlink (`/var`→`/private/var`) this string differs — but the
 * remover's `rm -rf` resolves ancestor symlinks at unlink and hits the same
 * inode, so it is correct as long as the remover follows symlinked ancestors.
 * The orchestrator guarantees the order: cut, then cleanup.
 */
export function makeEnder(config: {
  base: string
  cutter: CallCutter
  remover: SandboxRemover
}): Ender {
  const dirFor = (serviceId: string, sessionId: string): string =>
    path.join(serviceRoot(config.base, serviceId), sessionSegment(serviceId, sessionId))
  return {
    cut: (target) => config.cutter.cancelWhere((id) => id.workspaceId === target.workspaceId),
    cleanup: (target) => config.remover.remove(dirFor(target.serviceId, target.sessionId))
  }
}

// ── Composition ──────────────────────────────────────────────────────────────

/**
 * Assemble the instantiator's deps from the narrow handles. index.ts calls this
 * once with its concrete implementations; nothing else needs to know the shape.
 */
export function instantiatorDeps(parts: {
  templates: TemplateSource
  minter: Minter
  route: ConductorRoute
  ender: Ender
}): InstantiatorDeps {
  return parts
}
