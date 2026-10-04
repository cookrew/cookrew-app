// THE SAME TWO FACTS, ON EVERY VIEW OF A CARD.
//
// One component rather than three copies of `${model} ${effort}`, because the
// tag has to read identically on the canvas card, in the roster row and in the
// zoomed header — and the moment it is spelled out at three call sites, one of
// them starts showing the raw id while the other two show the alias.
//
// It renders NOTHING when nothing is recorded. A fresh agent that has not
// answered yet, a harness that keeps no session file, a plain shell: all of
// them get no tag, because an empty chip beside the harness name is itself a
// claim about what the agent is running on.

import { tuningTag, tuningTitle, tuningWords } from '../../../shared/agent-tuning'
import { useTuning } from '../tuning-store'

export function DialTag({
  id,
  className = 'vi-chip dial',
  stack = false
}: {
  id: string
  className?: string
  /**
   * Put the two parts on their own lines. For surfaces too narrow for the
   * one-line tag — the mini tile is about five characters wide at overview
   * zoom, where the single line clipped on every card and took the effort with
   * it. Stacking makes a long model id clip ALONE, so the effort always shows.
   */
  stack?: boolean
}): React.JSX.Element | null {
  const tuning = useTuning(id) ?? null
  const tag = tuningTag(tuning)
  if (tag === null) return null
  // The tag abbreviates a model to its alias; the title never does.
  const title = tuningTitle(tuning) ?? undefined
  if (!stack) {
    return (
      <span className={className} title={title}>
        {tag}
      </span>
    )
  }
  const { model, effort } = tuningWords(tuning)
  return (
    <span className={className} title={title}>
      {model !== null && <span className="dial-model">{model}</span>}
      {effort !== null && <span className="dial-effort">{effort}</span>}
    </span>
  )
}
