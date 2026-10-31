import type { TurnPhase } from '../../../shared/turn'
import { InkAvatar } from '../zoom/InkAvatar'
import { inkStatusOfTurn, type InkStatus } from '../zoom/ink-status'

/**
 * The agent's face where a card, a row or a header names it: its ink avatar
 * (zoom/InkAvatar.tsx), which carries the status itself (ink-status.ts):
 *   idle     the bare ink
 *   working  a red third of a turn lapping the ensō
 *   waiting  a closed red ring, blinking with the harness mark
 *   done     a red tick on the shoulder while the reply is unread
 *   offline  the ink faded under a z
 * Motion only for working and waiting (perf rule: resting faces never animate).
 */
export function AgentAvatar({ preset, status, id, orch = false }: { preset: string; status: InkStatus; id?: string; orch?: boolean }): React.JSX.Element {
  return (
    <span className={`vi-avatar ${status}`}>
      <InkAvatar id={id ?? preset} preset={preset} orch={orch} status={status} weight="small" />
    </span>
  )
}

/** The mini status face for dense places (mini tiles, the overlay and app headers): the ensō and its status, no harness mark. */
export function StatusCoin({ phase, preset, id, title }: { phase: TurnPhase | 'off'; preset?: string; id?: string; title?: string }): React.JSX.Element {
  const status = inkStatusOfTurn(phase)
  return (
    <span className={`vi-coin-led ${status}`} title={title} role={title ? 'img' : undefined} aria-label={title}>
      <InkAvatar id={id ?? preset ?? 'cookrew'} preset={preset ?? ''} status={status} weight="mini" />
    </span>
  )
}
