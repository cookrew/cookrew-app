// ONE AGENT'S TUNE BUTTON, WHEREVER IT IS DRAWN (owner 2026-11-01: it sits in
// the prompt box now, aimed at the agent the box talks to).
//
// The button reads what the agent's last reply ran on and turns its dials —
// model and effort typed into its pane, the route set on the card. It used to
// live inside the zoomed terminal and portal up to the top bar; now the prompt
// box draws it for whichever agent it is aimed at (an open card or a full view
// alike), and the embed's slim row draws it for the card it shows. The state
// belongs to the agent, so it lives here, not in either host.

import { useAgentTuning } from './use-agent-tuning'
import { useCardRoute } from './use-card-route'
import { TuneMenu } from './TuneMenu'
import { routeDialAllowed, routeDialInput, routeDialLines } from '../../../shared/route-view'
import { currentModelValue, modelAskState, modelRows } from '../../../shared/model-pick'
import type { ModelDialProps } from './ModelDial'
import type { TurnPhase } from '../../../shared/turn'
import { tuneSummary } from '../zoom-bar'

export interface CardTuneProps {
  terminalId: string
  phase: TurnPhase
  /** A line into a session elsewhere: no dial reaches it, and no route either (design D3). */
  remote: boolean
  /** Keep the caret where it is (the prompt box, the terminal) while the button is pressed. */
  onMouseDown?: (e: React.MouseEvent) => void
  /** Open up from the foot of the app (TuneMenu · rise). */
  rise?: boolean
  /** A dial was turned or a route picked: the prompt box takes the caret back (owner 2026-11-01). */
  onTurned?: () => void
}

export function CardTune({ terminalId, phase, remote, onMouseDown, rise = false, onTurned }: CardTuneProps): React.JSX.Element | null {
  const tuning = useAgentTuning({ terminalId, phase, remote })
  const routeAllowed = routeDialAllowed({ remote, served: remote })
  const cardRoute = useCardRoute({ terminalId, enabled: routeAllowed })
  // Main's choices, and only main's (route-view.routeDialInput).
  const routeDialBase = routeDialInput({ allowed: routeAllowed, routeChoices: tuning.routeChoices, state: cardRoute.state })
  const routeDial = routeDialBase
    ? {
        ...routeDialBase,
        state: cardRoute.state,
        open: cardRoute.open,
        onOpen: cardRoute.setOpen,
        onPick: (route: string) => {
          cardRoute.pick(route)
          onTurned?.()
        }
      }
    : null
  // THE ONE MODEL LIST (owner 2026-11-04): a claude card with a route dial
  // gets one MDL dial for model and route alike. Every pick goes to main as a
  // model pick (claude-model-route.ts), which saves the route and the flags
  // and restarts once, keeping the effort it runs at.
  const merged = tuning.state?.harness === 'claude' && routeDial !== null && !routeDial.notRoutable && routeDial.choices.length > 0
  const reading = tuning.state?.tuning ?? null
  const current = merged ? currentModelValue(cardRoute.state?.route ?? null, reading) : null
  const lines = routeDialLines(cardRoute.state)
  const model: ModelDialProps | null = merged
    ? {
        rows: modelRows(routeDial.choices),
        current,
        reading: reading?.model ?? null,
        ask: modelAskState(tuning.state?.asks ?? [], current, reading),
        // A direct card has no route turn: the last one is from before it went direct.
        turn: cardRoute.state?.route === 'direct' ? null : lines.turn,
        note: lines.note,
        open: tuning.open === 'model',
        onOpen: (open) => tuning.setOpen(open ? 'model' : null),
        onPick: (value) => {
          tuning.turn('model', value)
          onTurned?.()
        }
      }
    : null
  if (tuning.view === null) return null
  return (
    <TuneMenu
      model={model}
      view={tuning.view}
      open={tuning.open}
      onOpen={tuning.setOpen}
      onTurn={(knob, value) => {
        tuning.turn(knob, value)
        onTurned?.()
      }}
      error={tuning.error}
      onMouseDown={onMouseDown}
      rise={rise}
      route={routeDial}
      summary={tuneSummary({ dials: tuning.view.dials, routeDial: routeDial !== null, route: cardRoute.state?.route })}
    />
  )
}
