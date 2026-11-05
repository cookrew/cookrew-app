// One fleet service per companion server, made on first use from the deps
// the server already holds. Kept here so mobile-server.ts mounts the routes in
// a few lines and learns nothing about how the snapshot is made.

import type { EventEmitter } from 'node:events'
import type { AgentTuning } from '../../shared/agent-tuning'
import type { GitInfo } from '../../shared/model'
import type { MachineDisplay, MachineProfile } from '../../shared/fleet'
import type { BoardSources } from '../board-index'
import { machineProfile, provisionalProfile } from '../machine-profile'
import { createScrubber } from '../scrub'
import type { WorkspaceStore } from '../store'
import { runAtIdle } from './prewarm'
import { createFleetService, type FleetService } from './service'
import { levelsSourcesFrom } from './sources'

export interface FleetMountDeps {
  store: WorkspaceStore
  turns: EventEmitter
  board?: BoardSources
  tuning?: { fleet: () => Record<string, AgentTuning> }
  tuningBus?: EventEmitter
  identity?: { account: () => { name: string } | null }
  /** A prebuilt service (tests); otherwise one is made from the fields above. */
  fleet?: FleetService
}

const services = new WeakMap<object, FleetService>()

/** The profile as far as the probe has got: provisional until it answers, then fixed for the run. */
let profile: MachineProfile = provisionalProfile()
const profileListeners = new Set<() => void>()
let probing = false

function startProbe(): void {
  if (probing) return
  probing = true
  void machineProfile().then((answer) => {
    profile = answer
    for (const listener of profileListeners) listener()
  })
}

export interface FleetMountOptions {
  appVersion: () => string | null
  /** Tokens this desktop holds (the pairing token): scrubbed by value from every line. */
  tokens: () => readonly (string | null | undefined)[]
  /** The desktop's display (machine-display.ts); absent, the feed sends none. */
  display?: () => MachineDisplay | null
}

export function fleetServiceFor(deps: FleetMountDeps, options: FleetMountOptions): FleetService | null {
  if (deps.fleet) return deps.fleet
  if (!deps.board) return null
  const known = services.get(deps)
  if (known) return known
  startProbe()
  const service = createFleetService(
    levelsSourcesFrom({
      store: deps.store,
      board: deps.board,
      turns: deps.turns,
      tuning: deps.tuning,
      tuningBus: deps.tuningBus,
      machine: {
        name: () => deps.identity?.account()?.name ?? null,
        appVersion: options.appVersion(),
        profile: () => profile,
        display: options.display
      },
      onProfile: (listener) => {
        profileListeners.add(listener)
        return () => void profileListeners.delete(listener)
      },
      scrub: createScrubber({ tokens: options.tokens })
    })
  )
  services.set(deps, service)
  return service
}

/** How long after the companion server starts the prewarm begins: boot has its own work first. */
export const FLEET_PREWARM_DELAY_MS = 15_000

/**
 * Pay the cold first build at idle, so the first shell to open a machine does
 * not. Once per server; nothing happens when the board is not wired.
 */
export function prewarmFleet(deps: FleetMountDeps, options: FleetMountOptions, delayMs = FLEET_PREWARM_DELAY_MS): void {
  const timer = setTimeout(() => {
    try {
      const service = fleetServiceFor(deps, options)
      if (service) void runAtIdle(service.prewarmSteps())
    } catch (error) {
      // A prewarm that cannot start is a first request that builds cold, nothing worse.
      console.error('Fleet prewarm could not start:', error)
    }
  }, delayMs)
  timer.unref?.()
}
