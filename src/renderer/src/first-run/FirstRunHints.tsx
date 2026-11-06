import { useEffect, useState } from 'react'
import { activityStore } from '../activity-thumb-store'
import { PairPhoneSheet } from '../account/PairPhoneSheet'
import { HINT_COPY } from '../../../shared/first-run-copy'
import { sentTurnDone, stepTurns, stillFinished, type TurnMemory } from './first-run-rules'
import { firstRun, useFirstRunStage, useFirstTask } from './first-run-state'
import './first-run.css'

/**
 * TWO SMALL CARDS, EACH SHOWN ONCE. The first finished turn offers the phone;
 * a later one teaches a second agent. The stage moves the moment a card shows,
 * not when it is closed: "once" must hold through a quit with the card open. It
 * is also what moves the first task on, so a refused turn moves nothing.
 * Neither card stops anything, and the second waits for the first to go.
 */

export type HintKind = 'phone' | 'second'

const SETTLE_MS = 2_500

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
  const task = useFirstTask()
  const sent = task?.state === 'sent' ? task : null
  const [shown, setShown] = useState<HintKind | null>(null)
  const [pairing, setPairing] = useState(false)
  useEffect(() => {
    if ((stage !== 'phone' && stage !== 'second' && sent === null) || shown !== null) return
    const kind: HintKind = sent !== null || stage === 'phone' ? 'phone' : 'second'
    let memory: TurnMemory = new Map()
    let settling: ReturnType<typeof setTimeout> | null = null
    // Replied can be a pause between steps: look again before saying "finished".
    const settle = (id: string): void => {
      if (settling !== null) return
      settling = setTimeout(() => {
        settling = null
        const activity = activityStore.get(id)
        if (!(sent ? sentTurnDone(sent, activity) : stillFinished(activity))) return
        setShown(kind)
        void firstRun.advance(kind === 'phone' ? 'second' : 'closed')
      }, SETTLE_MS)
    }
    const read = (): void => {
      if (sent !== null) {
        if (sentTurnDone(sent, activityStore.get(sent.id))) settle(sent.id)
        return
      }
      const step = stepTurns(memory, Object.values(activityStore.getSnapshot()))
      memory = step.memory
      if (step.ended.length > 0) settle(step.ended[0])
    }
    read()
    const off = activityStore.subscribeGlobal(read)
    return () => {
      off()
      if (settling !== null) clearTimeout(settling)
    }
  }, [stage, shown, sent])
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
