import { randomUUID } from 'node:crypto'
import { conductorWaits, type FirstRunStage } from '../shared/first-run'
import { DEFAULT_TERMINAL_SIZE } from '../shared/model'
import { folderFailure, toolSeen } from './launch-check'
import { DEFAULT_ORCH_PRESET } from './presets'
import type { WorkspaceStore } from './store'

export interface SeedDeps {
  store: Pick<WorkspaceStore, 'workspaceState' | 'addNodeToWorkspace'>
  stage: () => FirstRunStage
  /** The PATH a pane will export. */
  searchPath: () => string
}

/**
 * Give an empty workspace an orch terminal. It opens the default orch preset,
 * Claude with bypassed permissions, so the conductor can act without stalling on
 * approvals.
 *
 * NOBODY ASKED FOR THIS CARD, so the bar is the opposite of a card someone did
 * ask for (launch-check.ts): it is made only where its tool is seen. Without one
 * the workspace stays empty and says how to add an agent, which beats a card
 * reading "resting" that dies on its first key (round 2, bug 14).
 */
export function seedConductor({ store, stage, searchPath }: SeedDeps, workspaceId: string): void {
  const state = store.workspaceState(workspaceId)
  if (state.nodes.some((node) => node.kind === 'terminal') || conductorWaits(stage())) return
  if (folderFailure(state.dir) || !toolSeen(DEFAULT_ORCH_PRESET.command, state.dir, searchPath())) return
  store.addNodeToWorkspace(workspaceId, {
    kind: 'terminal',
    id: randomUUID(),
    name: 'Conductor',
    preset: DEFAULT_ORCH_PRESET.name,
    command: DEFAULT_ORCH_PRESET.command,
    cwd: state.dir,
    orch: true,
    role: null,
    position: { x: 240, y: 200 },
    size: DEFAULT_TERMINAL_SIZE
  })
}
