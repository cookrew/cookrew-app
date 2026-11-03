// scene(path) for the stage: one level, from its pure model.
import { AgentsLevel } from './AgentsLevel'
import { MachinesLevel } from './MachinesLevel'
import type { LevelModel } from './model'
import { TerminalLevel } from './TerminalLevel'
import { WorkspacesLevel } from './WorkspacesLevel'

export function Scene({ model, openFinder }: { model: LevelModel; openFinder: (query?: string) => void }) {
  switch (model.level) {
    case 'machines':
      return <MachinesLevel model={model} openFinder={openFinder} />
    case 'workspaces':
      return <WorkspacesLevel model={model} openFinder={openFinder} />
    case 'agents':
      return <AgentsLevel model={model} openFinder={openFinder} />
    case 'terminal':
      return <TerminalLevel model={model} />
  }
}
