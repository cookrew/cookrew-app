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

import { tuningTag, tuningTitle } from '../../../shared/agent-tuning'
import { useTuning } from '../tuning-store'

export function DialTag({
  id,
  className = 'vi-chip dial'
}: {
  id: string
  className?: string
}): React.JSX.Element | null {
  const tuning = useTuning(id) ?? null
  const tag = tuningTag(tuning)
  if (tag === null) return null
  // The tag abbreviates a model to its alias; the title never does.
  return (
    <span className={className} title={tuningTitle(tuning) ?? undefined}>
      {tag}
    </span>
  )
}
