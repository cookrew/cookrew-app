// THE LEVELS VIEW: the window's main view as machines → workspaces → agents
// → the agent's terminal, the same shell cookrew.dev draws for the fleet,
// here over this desktop alone. It covers the stage like the board view: the
// canvas keeps running underneath (its live panes must never remount), and
// the header above keeps the way back to it.
//
// ⌘K stays the app's command box; the finder answers / and type-to-find.
import { useEffect } from 'react'
import { StrataShell } from '../../../strata/Shell'
import type { LoadDetail, TerminalSlot } from '../../../strata/levels/env'
import { cookrew } from '../api'
import { useLevelsHistory } from './levels-history'
import { LevelsTerminal } from './LevelsTerminal'
import { useLocalFleet, useLocalFleetLoaded } from './local-fleet'
import './levels.css'

const loadDetail: LoadDetail = async (_machine, agentId) => {
  const read = cookrew().getLevelsAgent
  if (!read) throw new Error('This desktop cannot open agents from the levels yet.')
  const detail = await read(agentId)
  if (!detail) throw new Error('That agent is not here any more.')
  return detail
}

const terminalSlot: TerminalSlot = (props) => <LevelsTerminal {...props} />

export function LevelsView({ onTerminal }: {
  /** The agent whose terminal is open at level 3 (null elsewhere): the dock's composer follows it. */
  onTerminal: (agentId: string | null) => void
}): React.JSX.Element {
  const fleet = useLocalFleet()
  const loaded = useLocalFleetLoaded()
  const history = useLevelsHistory(fleet, loaded)
  const agentId = history.path.agent ?? null

  useEffect(() => onTerminal(agentId), [agentId, onTerminal])
  useEffect(() => () => onTerminal(null), [onTerminal])

  return (
    <div className="cr-levels">
      <StrataShell fleet={fleet} loaded={loaded} history={history} terminal={terminalSlot} loadDetail={loadDetail} modK={false} />
    </div>
  )
}
