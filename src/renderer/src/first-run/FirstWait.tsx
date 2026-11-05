import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import { SetupScreen } from '../routing/SetupScreen'
import { WAIT_COPY } from '../../../shared/first-run-copy'
import type { FirstTask } from '../../../shared/first-run'

/**
 * THE FIRST TASK, WAITING FOR ITS AGENT (round 2, bug 4). A new Claude opens on a
 * theme picker, then notes, a consent and maybe a sign-in, while the card read
 * RESTING. This screen stands over the board until the agent has the words, with
 * the agent's real terminal to answer in: those screens have no numbered rows, so
 * the prompt box could not draw them, and a live pane answers them all.
 */

type Holding = Extract<FirstTask, { state: 'holding' }>

export function FirstWaitView({
  task,
  onCancel,
  onEndpoint,
  children
}: {
  task: Holding
  onCancel: () => void
  onEndpoint: () => void
  /** The agent's live terminal. */
  children?: React.ReactNode
}): React.JSX.Element {
  const copy = WAIT_COPY[task.wait]
  const title = copy.title(task.harness)
  return (
    <section className="fr-stage fr-wait" aria-label={title}>
      <div className="fr-col">
        <h1 className="fr-title">{title}</h1>
        <p className="fr-lede">{copy.lede}</p>
        {task.wait !== 'starting' && <div className="fr-setup">{children}</div>}
        <p className="fr-held">
          <span>{WAIT_COPY.TASK}</span> {task.words}
        </p>
        <div className="fr-foot">
          {task.wait === 'sign-in' && (
            <button type="button" className="fr-go" onClick={onEndpoint}>
              {WAIT_COPY.NO_ACCOUNT}
            </button>
          )}
          <button type="button" className="fr-quiet" onClick={onCancel}>
            {WAIT_COPY.CANCEL}
          </button>
        </div>
      </div>
    </section>
  )
}

export function FirstWait({ task, onEndpoint }: { task: Holding; onEndpoint: () => void }): React.JSX.Element {
  // Each new question is answered with keys, so the pane takes them at once.
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => setFocusTick((tick) => tick + 1), [task.wait])
  const discard = (): void => void cookrew().firstRunDiscard?.()
  return (
    <FirstWaitView
      task={task}
      onCancel={discard}
      onEndpoint={() => {
        discard()
        onEndpoint()
      }}
    >
      <SetupScreen terminalId={task.id} focusTick={focusTick} fit="whole" />
    </FirstWaitView>
  )
}
