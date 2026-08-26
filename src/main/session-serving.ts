import {
  SessionInstantiator,
  type ConductorRoute,
  type Ender,
  type Minter,
  type TemplateSource
} from './session-instantiator'
import {
  instantiatorDeps,
  makeConductorRoute,
  makeEnder,
  makeMinter,
  makeTemplateSource,
  type CallCutter,
  type EntryTerminalLookup,
  type ForkEngine,
  type PinResolver,
  type SandboxRemover,
  type TeamLoad
} from './session-instantiator-adapters'
import { ServedTemplates, resolveCallScope, type ServedTemplate } from './session-served'
import type { ServedPersistence } from './served-persist'

/**
 * THE COMPOSITION ROOT for R30 serving. index.ts calls `wireServing` ONCE with
 * its real subsystem handles and gets back the three things the app holds: the
 * registry of served templates, the instantiator, and one function the call
 * path consults. Everything else — the four adapters, the ordinal ledger, the
 * gate walk — is assembled here, so index.ts learns none of it and its diff is a
 * single construction plus the call-seam consult.
 *
 * WHY A ROOT AND NOT INLINE. index.ts is a 2,500-line singleton; threading four
 * adapters through it by hand is how a wiring bug hides. Assembling them behind
 * one factory that takes narrow handles keeps the wiring testable (this file has
 * its own test) and the app edit mechanical.
 */

/** The handles index.ts supplies — each the smallest slice of a real subsystem. */
export interface ServingDeps {
  /** The sessions/sandbox root — `~/.cookrew`. */
  base: string
  /** `TeamStore` — resolves a template id to a snapshot (existence only, here). */
  teams: TeamLoad
  /** Resolves a template id to its pinned {version, pinAddress} (S1c). */
  pins: PinResolver
  /** Mints a sandboxed workspace from a template — index wraps forkTeam. */
  forkEngine: ForkEngine
  /** A live workspace's entry/orch terminal — the scoped lookup, never focused. */
  entry: EntryTerminalLookup
  /** The revoke seam END cuts through. */
  callsInFlight: CallCutter
  /** rm -rf the sandbox. */
  remover: SandboxRemover
  /** The owner's own live workspace for a slug, or null — `store.bySlug(slug)?.id`. */
  liveWorkspaceId(slug: string): string | null
  /**
   * Disk persistence for the served registry. Serving must survive a restart —
   * an owner stops serving by saying stop, never by rebooting. Optional so unit
   * wirings that only exercise the call path need not fake a filesystem.
   */
  persist?: ServedPersistence
}

/** What an inbound call resolves to once the caller is known. */
export type InboundCall =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'served'; workspaceId: string; conductorId: string | null; created: boolean }
  | { kind: 'none' }

export interface Serving {
  served: ServedTemplates
  instantiator: SessionInstantiator
  /**
   * Resolve an inbound slug for an AUTHENTICATED caller. A live workspace is
   * answered as always; a served slug mints (or reuses) that caller's session
   * and returns its workspace + conductor; an unknown slug is `none` (404).
   *
   * accountId is the verified credential subject, so this is called AFTER the
   * gate authorizes — a stranger cannot mint by naming a slug, only a caller the
   * service already enrolled can.
   */
  resolveInboundCall(slug: string, accountId: string): Promise<InboundCall>
  /** Serve a template under a slug (owner IPC only). Clones defensively. */
  serve(input: ServedTemplate): void
  /** Stop serving (owner IPC only). */
  stop(serviceId: string): void
}

export function wireServing(deps: ServingDeps): Serving {
  const served = new ServedTemplates()
  // Rehydrate: what was serving when the app died is still being served. A
  // record serve() refuses (price-shape rules may have tightened since it was
  // written) is dropped rather than allowed to stop the boot.
  for (const template of deps.persist?.load() ?? []) {
    try {
      served.serve(template)
    } catch {
      // dropped — an invalid door stays closed
    }
  }
  const saveServed = (): void => deps.persist?.save(served.list())

  // A service's template id is the one it was served with; asking for a service
  // that is not served is a bug, not a caller state, so it throws.
  const templateIdOf = (serviceId: string): string => {
    const template = served.byService(serviceId)
    if (!template) throw new Error(`service '${serviceId}' is not being served`)
    return template.templateId
  }

  const templates: TemplateSource = makeTemplateSource(templateIdOf, deps.teams, deps.pins)
  const minter: Minter = makeMinter({
    base: deps.base,
    engine: deps.forkEngine,
    remover: deps.remover
  })
  const route: ConductorRoute = makeConductorRoute(deps.entry)
  const ender: Ender = makeEnder({ base: deps.base, cutter: deps.callsInFlight, remover: deps.remover })

  const instantiator = new SessionInstantiator(instantiatorDeps({ templates, minter, route, ender }))

  const resolveInboundCall = async (slug: string, accountId: string): Promise<InboundCall> => {
    const scope = resolveCallScope(slug, {
      liveWorkspaceId: deps.liveWorkspaceId,
      servedBySlug: (s) => served.bySlug(s)
    })
    if (scope.kind === 'workspace') return { kind: 'workspace', workspaceId: scope.workspaceId }
    if (scope.kind === 'none') return { kind: 'none' }

    const { session, created } = await instantiator.admit(scope.service.serviceId, accountId)
    return {
      kind: 'served',
      workspaceId: session.workspaceId,
      conductorId: instantiator.conductorFor(session.identity.sessionId),
      created
    }
  }

  return {
    served,
    instantiator,
    resolveInboundCall,
    serve: (input) => {
      served.serve(input)
      saveServed()
    },
    stop: (serviceId) => {
      served.stop(serviceId)
      saveServed()
    }
  }
}
