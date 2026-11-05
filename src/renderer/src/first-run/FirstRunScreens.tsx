import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { activityStore } from '../activity-thumb-store'
import { cookrew } from '../api'
import { zoomStore } from '../zoom/zoom-store'
import { draftKey, getDraft, setDraft } from '../prompt/prompt-draft'
import type { CanvasNode } from '../../../shared/model'
import { FIRST_SCREEN_COPY } from '../../../shared/first-run-copy'
import { FirstScreen } from './FirstScreen'
import { FirstWait } from './FirstWait'
import { Preflight, type PreflightSetup } from './Preflight'
import { otherAgentEnds, sentTurnFailed } from './first-run-rules'
import { firstRun, useFirstRunStage, useFirstTask } from './first-run-state'
import './first-run.css'

/**
 * THE FIRST RUN'S FULL SCREENS, where the zoom's empty state used to be. They
 * stand over the stage, whatever stop the zoom is on, because the Setup card a
 * fix makes would otherwise appear behind them as the board's first agent.
 *
 * A first task steps these screens aside once the agent has it, and a good end
 * to its turn moves the stage (main/first-task.ts, FirstRunHints.tsx). An agent
 * made some other way (a phone, the CLI) ends these screens once it is
 * seen working: a card alone proves nothing, as a dead one has a card too.
 *
 * NOTHING HERE IS A DEAD END. The tool check stays one press from the first
 * screen, and "Look around first" steps out for this launch with a way back.
 */
export function FirstRunScreens({ nodes, setup }: { nodes: readonly CanvasNode[]; setup: PreflightSetup }): React.JSX.Element | null {
  const stage = useFirstRunStage()
  const task = useFirstTask()
  const [checking, setChecking] = useState(false)
  const [away, setAway] = useState(false)
  const showing = stage === 'preflight' || stage === 'task'
  const holding = task?.state === 'holding' ? task : null
  const sent = task?.state === 'sent' ? task : null
  const refused = useSyncExternalStore(activityStore.subscribeGlobal.bind(activityStore), () => sentTurnFailed(sent, sent ? activityStore.get(sent.id) : undefined), () => false)
  useEffect(() => {
    if (!showing || holding !== null) return
    const read = (): void => {
      if (otherAgentEnds(nodes, Object.values(activityStore.getSnapshot()), task)) void firstRun.advance('phone')
    }
    read()
    return activityStore.subscribeGlobal(read)
  }, [showing, task, nodes])
  // The agent never took them: the words go back where they were typed.
  useEffect(() => {
    if (task?.state === 'returned' && showing && getDraft(draftKey(null)) === '') setDraft(draftKey(null), task.words)
  }, [task, showing])
  const toolCheck = stage === 'preflight' || (stage === 'task' && checking && sent === null)
  const fullPage = showing && (toolCheck || holding !== null)
  const firstScreen = stage === 'task' && !fullPage && !away && sent === null
  useLayoutEffect(() => {
    const body = document.body.classList
    body.toggle('cr-first-preflight', fullPage)
    body.toggle('cr-first-task', firstScreen)
    return () => {
      body.remove('cr-first-preflight')
      body.remove('cr-first-task')
    }
  }, [fullPage, firstScreen])
  if (!showing) return null
  if (holding) return <FirstWait task={holding} onEndpoint={() => setChecking(true)} />
  // Working: out of the way. Refused: its card says why, and this is the way back.
  if (sent) {
    return refused ? (
      <button
        type="button"
        className="fr-back"
        onClick={() => {
          zoomStore.go(1, 'agents')
          void cookrew().firstRunDiscard?.()
        }}
      >
        {FIRST_SCREEN_COPY.BACK}
      </button>
    ) : null
  }
  if (toolCheck) return <Preflight setup={setup} onDone={() => setChecking(false)} />
  if (away) {
    return (
      <button type="button" className="fr-back" onClick={() => setAway(false)}>
        {FIRST_SCREEN_COPY.BACK}
      </button>
    )
  }
  return <FirstScreen returned={task?.state === 'returned' ? task.why : null} onCheck={() => setChecking(true)} onLater={() => setAway(true)} />
}
