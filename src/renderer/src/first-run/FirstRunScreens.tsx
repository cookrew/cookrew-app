import { useEffect, useLayoutEffect } from 'react'
import type { CanvasNode } from '../../../shared/model'
import { FirstScreen } from './FirstScreen'
import { Preflight, type PreflightSetup } from './Preflight'
import { realAgents } from './first-run-rules'
import { firstRun, useFirstRunStage } from './first-run-state'
import './first-run.css'

/**
 * THE FIRST RUN'S FULL SCREENS, where the zoom's empty state used to be. They
 * stand over the stage, whatever stop the zoom is on, because the Setup card
 * a fix makes would otherwise appear behind them as the board's first agent.
 *
 * An agent made any way at all (this box, a phone, the CLI) ends them: the
 * person is past the screens that teach starting one.
 */
export function FirstRunScreens({ nodes, setup }: { nodes: readonly CanvasNode[]; setup: PreflightSetup }): React.JSX.Element | null {
  const stage = useFirstRunStage()
  const showing = stage === 'preflight' || stage === 'task'
  const agents = realAgents(nodes)
  useEffect(() => {
    if (showing && agents > 0) void firstRun.advance('phone')
  }, [showing, agents])
  useLayoutEffect(() => {
    const body = document.body.classList
    body.toggle('cr-first-preflight', stage === 'preflight')
    body.toggle('cr-first-task', stage === 'task')
    return () => {
      body.remove('cr-first-preflight')
      body.remove('cr-first-task')
    }
  }, [stage])
  if (stage === 'preflight') return <Preflight setup={setup} />
  return stage === 'task' ? <FirstScreen /> : null
}
