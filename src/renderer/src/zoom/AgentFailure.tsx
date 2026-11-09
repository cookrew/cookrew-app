import { useState } from 'react'
import type { LaunchFailure } from '../../../shared/launch-failure'
import { cookrew } from '../api'

/**
 * WHY THIS CARD IS NOT RUNNING, and the one thing to do about it. Drawn where
 * the agent's latest would be: a card that cannot start has no latest, and the
 * reason is the only true thing to say (box test 2, bug 2).
 */
export function AgentFailure({ failure, agentId }: { failure: LaunchFailure; agentId?: string }): React.JSX.Element {
  return (
    <div className="ag-latest ag-failure">
      <b className="ag-failure-why">{failure.why}</b>
      <span className="ag-failure-fix">{failure.fix}</span>
      {failure.kind === 'folder-untrusted' && agentId !== undefined && <TrustFolder agentId={agentId} />}
      {failure.lastLines.length > 0 && <pre className="ag-failure-tail">{failure.lastLines.join('\n')}</pre>}
    </div>
  )
}

/**
 * The person's answer to Claude's "Is this a project you trust?", asked once for
 * a folder Cookrew does not trust alone (a home folder, or above it). The card's
 * failure goes when main has looked again; until then the button says what it did.
 */
function TrustFolder({ agentId }: { agentId: string }): React.JSX.Element | null {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle')
  const trust = cookrew().trustCardFolder
  if (!trust) return null
  const onTrust = (): void => {
    setState('working')
    trust(agentId).then(
      ({ outcome }) => setState(outcome === 'trusted' || outcome === 'already-trusted' ? 'done' : 'failed'),
      () => setState('failed')
    )
  }
  const label = state === 'done' ? 'Trusted. Send again to start it.' : state === 'failed' ? 'Could not trust it. Try again' : 'Trust this folder'
  return (
    <button type="button" className="ag-failure-go" disabled={state === 'working' || state === 'done'} onClick={onTrust}>
      {label}
    </button>
  )
}
