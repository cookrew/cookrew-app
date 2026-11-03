import { InkAvatar } from '../zoom/InkAvatar'
import type { FaceAgent } from './PromptFace'

/**
 * WHO THE WORDS GO TO (owner design, 2026-11-03): a tap on the face of an
 * empty box opens this. Whoever waits on you, then the most recently active,
 * then a new agent on each harness. One row of faces above the box on a phone
 * (it fits over the keyboard), a list above the face on a wide screen — the
 * same markup, laid out by prompt-face.css.
 *
 * A pick stands until the zoom's next deliberate move (prompt-target.ts ·
 * boxTargetId `picked`); a new agent's pick lets go of the agent in the box.
 * Esc closes it first (the box's own keys, GlobalPrompt.tsx), then folds the box.
 */

export interface WhoPickerProps {
  waiting: readonly FaceAgent[]
  recent: readonly FaceAgent[]
  /** Its title: "recent", or "used it" in a browser's or a note's full view. */
  recentTitle: string
  harnesses: readonly string[]
  current: { id: string | null; harness: string }
  onAgent: (id: string) => void
  onNew: (harness: string) => void
}

function Row({ agent, harness, current, sub, onPick }: { agent: FaceAgent | null; harness: string; current: boolean; sub: string; onPick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={current}
      className={`pf-who-row${agent ? '' : ' new'}${agent?.status === 'waiting' ? ' waiting' : ''}`}
      // Keep the box's caret: the words are what comes next.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className="pf-who-face">
        <InkAvatar id={agent?.id ?? `new:${harness}`} preset={agent?.preset ?? harness} orch={agent?.orch ?? false} status={agent?.status ?? 'idle'} weight="regular" />
      </span>
      <b>{agent ? agent.name : harness}</b>
      <small>{sub}</small>
    </button>
  )
}

const SUB: Record<string, string> = { waiting: 'needs you', working: 'working', done: 'done', offline: 'offline', idle: '' }

export function WhoPicker({ waiting, recent, recentTitle, harnesses, current, onAgent, onNew }: WhoPickerProps): React.JSX.Element {
  const group = (title: string, rows: React.ReactNode): React.ReactNode => (
    <div className="pf-who-group" role="group" aria-label={title}>
      <h6>{title}</h6>
      <div className="pf-who-rows">{rows}</div>
    </div>
  )
  return (
    <div className="pf-who" role="listbox" aria-label="Send to">
      {waiting.length > 0 &&
        group(
          'needs you',
          waiting.map((a) => <Row key={a.id} agent={a} harness={a.preset} current={current.id === a.id} sub={SUB.waiting} onPick={() => onAgent(a.id)} />)
        )}
      {recent.length > 0 &&
        group(
          recentTitle,
          recent.map((a) => <Row key={a.id} agent={a} harness={a.preset} current={current.id === a.id} sub={SUB[a.status] ?? ''} onPick={() => onAgent(a.id)} />)
        )}
      {group(
        'new agent',
        harnesses.map((h) => <Row key={h} agent={null} harness={h} current={current.id === null && current.harness === h} sub="" onPick={() => onNew(h)} />)
      )}
    </div>
  )
}
