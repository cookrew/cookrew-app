import { useEffect, useState } from 'react'
import { activityStore } from '../activity-thumb-store'
import { PairPhoneSheet } from '../account/PairPhoneSheet'
import { HINT_COPY } from '../../../shared/first-run-copy'
import { stepTurns, type TurnMemory } from './first-run-rules'
import { firstRun, useFirstRunStage } from './first-run-state'
import './first-run.css'

/**
 * TWO SMALL CARDS, EACH SHOWN ONCE. The first finished turn offers the phone;
 * a later one teaches a second agent. The stage moves the moment a card shows,
 * not when it is closed: "once" must hold through a quit with the card open.
 * Neither card stops anything, and the second waits for the first to go.
 */

export type HintKind = 'phone' | 'second'

export function HintCard({ kind, onGo, onClose }: { kind: HintKind; onGo: () => void; onClose: () => void }): React.JSX.Element {
  const phone = kind === 'phone'
  const title = phone ? HINT_COPY.PHONE_TITLE : HINT_COPY.SECOND_TITLE
  return (
    <aside className="fr-hint" aria-label={title}>
      <b>{title}</b>
      <p>{phone ? HINT_COPY.PHONE_LEDE : HINT_COPY.SECOND_LEDE}</p>
      <div className="fr-hint-foot">
        <button type="button" className="fr-go" onClick={onGo}>
          {phone ? HINT_COPY.PHONE_GO : HINT_COPY.SECOND_GO}
        </button>
        {phone && (
          <button type="button" className="fr-quiet" onClick={onClose}>
            {HINT_COPY.NOT_NOW}
          </button>
        )}
      </div>
    </aside>
  )
}

export function FirstRunHints(): React.JSX.Element | null {
  const stage = useFirstRunStage()
  const [shown, setShown] = useState<HintKind | null>(null)
  const [pairing, setPairing] = useState(false)
  useEffect(() => {
    if ((stage !== 'phone' && stage !== 'second') || shown !== null) return
    let memory: TurnMemory = new Map()
    const read = (): void => {
      const step = stepTurns(memory, Object.values(activityStore.getSnapshot()))
      memory = step.memory
      if (!step.ended) return
      setShown(stage)
      void firstRun.advance(stage === 'phone' ? 'second' : 'closed')
    }
    read()
    return activityStore.subscribeGlobal(read)
  }, [stage, shown])
  return (
    <>
      {shown && (
        <HintCard
          kind={shown}
          onClose={() => setShown(null)}
          onGo={() => {
            if (shown === 'phone') setPairing(true)
            setShown(null)
          }}
        />
      )}
      {pairing && <PairPhoneSheet onClose={() => setPairing(false)} />}
    </>
  )
}
