// One levels service per companion server, made on first use from the deps
// the server already holds. Kept here so mobile-server.ts mounts the routes in
// a few lines and learns nothing about how the snapshot is made.

import type { EventEmitter } from 'node:events'
import type { AgentTuning } from '../../shared/agent-tuning'
import type { GitInfo } from '../../shared/model'
import type { MachineProfile } from '../../shared/strata'
import type { BoardSources } from '../board-index'
import { machineProfile, provisionalProfile } from '../machine-profile'
import { createScrubber } from '../scrub'
import type { WorkspaceStore } from '../store'
import { createLevelsService, type LevelsService } from './service'
import { levelsSourcesFrom } from './sources'

export interface LevelsMountDeps {
  store: WorkspaceStore
  turns: EventEmitter
  board?: BoardSources
  tuning?: { fleet: () => Record<string, AgentTuning> }
  tuningBus?: EventEmitter
  identity?: { account: () => { name: string } | null }
  /** A cwd's cached git answer, never a query (the detail's node.git). */
  gitPeek?: (dir: string) => GitInfo | undefined
  /** A prebuilt service (tests); otherwise one is made from the fields above. */
  levels?: LevelsService
}

const services = new WeakMap<object, LevelsService>()

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

export interface LevelsMountOptions {
  appVersion: () => string | null
  /** Tokens this desktop holds (the pairing token): scrubbed by value from every line. */
  tokens: () => readonly (string | null | undefined)[]
}

export function levelsServiceFor(deps: LevelsMountDeps, options: LevelsMountOptions): LevelsService | null {
  if (deps.levels) return deps.levels
  if (!deps.board) return null
  const known = services.get(deps)
  if (known) return known
  startProbe()
  const service = createLevelsService(
    levelsSourcesFrom({
      store: deps.store,
      board: deps.board,
      turns: deps.turns,
      tuning: deps.tuning,
      tuningBus: deps.tuningBus,
      machine: {
        name: () => deps.identity?.account()?.name ?? null,
        appVersion: options.appVersion(),
        profile: () => profile
      },
      onProfile: (listener) => {
        profileListeners.add(listener)
        return () => void profileListeners.delete(listener)
      },
      scrub: createScrubber({ tokens: options.tokens }),
      gitPeek: deps.gitPeek
    })
  )
  services.set(deps, service)
  return service
}
