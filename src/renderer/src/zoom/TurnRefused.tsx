import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import { REFUSED_COPY } from '../../../shared/first-run-copy'
import { refusalKind } from '../../../shared/turn-failure'

/**
 * THE MODEL SERVICE REFUSED THE TURN. What that means comes first, in a sentence;
 * what the service said stays one press away (box round 3, N3: the card read a
 * Jinja template error and nothing else). Where simple mode is the fix it is offered
 * here, and it needs no key: main has it. An agent reads its settings as it starts,
 * so the press also starts this card again.
 */

export type SimpleFix = 'idle' | 'working' | 'done' | 'saved' | 'failed'

const hold = (e: React.SyntheticEvent): void => e.stopPropagation()

export function TurnRefusedView({ raw, offer, state, onFix }: { raw: string; offer: boolean; state: SimpleFix; onFix: () => void }): React.JSX.Element {
  const kind = refusalKind(raw)
  // A wrong key or a limit is not something sending less can answer.
  const fixable = offer && kind === 'request' && (state === 'idle' || state === 'working' || state === 'failed')
  return (
    <div className="ag-latest ag-failure" onClick={hold} onPointerDown={hold}>
      <b className="ag-failure-why">{REFUSED_COPY[kind]}</b>
      {fixable && (
        <button type="button" className="ag-failure-go" disabled={state === 'working'} onClick={onFix}>
          {state === 'working' ? REFUSED_COPY.SIMPLE_WORKING : REFUSED_COPY.SIMPLE_GO}
        </button>
      )}
      {fixable && <span className="ag-failure-fix">{REFUSED_COPY.SIMPLE_WHY}</span>}
      {state === 'failed' && (
        <span className="ag-failure-fix" role="alert">
          {REFUSED_COPY.SIMPLE_FAILED}
        </span>
      )}
      {state === 'done' && <span className="ag-failure-fix">{REFUSED_COPY.SIMPLE_DONE}</span>}
      {state === 'saved' && <span className="ag-failure-fix">{REFUSED_COPY.SIMPLE_SAVED}</span>}
      <details className="ag-failure-raw">
        <summary>{REFUSED_COPY.DETAILS}</summary>
        <pre className="ag-failure-tail">{raw}</pre>
      </details>
    </div>
  )
}

export function TurnRefused({ id, raw }: { id: string; raw: string }): React.JSX.Element {
  const [offer, setOffer] = useState(false)
  const [state, setState] = useState<SimpleFix>('idle')
  useEffect(() => {
    let live = true
    // A new refusal is a new question: "send your task again" was about the last one.
    setState('idle')
    void cookrew()
      .accessSimpleOffer?.(id)
      .then((yes) => live && setOffer(yes))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [id, raw])
  const fix = (): void => {
    setState('working')
    void (cookrew().accessSimple?.({ terminalId: id }) ?? Promise.resolve({ ok: false as const }))
      .then((answer) => setState(!answer.ok ? 'failed' : answer.restarted ? 'done' : 'saved'))
      .catch(() => setState('failed'))
  }
  return <TurnRefusedView raw={raw} offer={offer || state !== 'idle'} state={state} onFix={fix} />
}
