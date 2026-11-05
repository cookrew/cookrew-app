import type { LaunchFailure } from '../../../shared/launch-failure'

/**
 * WHY THIS CARD IS NOT RUNNING, and the one thing to do about it. Drawn where
 * the agent's latest would be: a card that cannot start has no latest, and the
 * reason is the only true thing to say (box test 2, bug 2).
 */
export function AgentFailure({ failure }: { failure: LaunchFailure }): React.JSX.Element {
  return (
    <div className="ag-latest ag-failure">
      <b className="ag-failure-why">{failure.why}</b>
      <span className="ag-failure-fix">{failure.fix}</span>
      {failure.lastLines.length > 0 && <pre className="ag-failure-tail">{failure.lastLines.join('\n')}</pre>}
    </div>
  )
}
