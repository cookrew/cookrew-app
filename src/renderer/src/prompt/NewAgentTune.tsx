import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { keyboardCoverNow, riseOver, riseStyle, typesIntoBox, type RiseAnchor, topBarBottom } from './rise-anchor'
import { LAUNCH_KNOBS, effortOffer, launchTuneLabel, type LaunchKnob, type LaunchOffer, type LaunchTune } from '../../../shared/launch-tune'
import { effortLevelsFor, modelChipText, modelRows } from '../../../shared/model-pick'
import { shortRoute } from '../../../shared/route-view'
import { ModelList, centerCurrent } from '../nodes/ModelDial'

/**
 * The gateway, for THE ONE MODEL LIST (owner 2026-11-04): a new claude agent
 * picks from the rows the live agent's MDL dial shows (ModelDial.ModelList),
 * and "default" names what the default route runs instead of hiding it.
 */
export interface NewAgentGateway {
  /** route-view.routeChoices: direct, groups, models. */
  ids: readonly string[]
  models: readonly { id: string; levels: readonly string[] }[]
  defaultModel: string | null
}

/** The chip's words: what the new agent will run on, and at what effort. */
export function newAgentLabel(tune: LaunchTune, gateway: NewAgentGateway): string {
  const model = tune.model ? modelChipText(tune.model) : gateway.defaultModel ? shortRoute(gateway.defaultModel) : 'default'
  return tune.effort ? `${model} · ${tune.effort}` : model
}

/**
 * THE NEW AGENT'S TUNE CHIP (owner, 2026-11-01). With nobody targeted the
 * prompt box makes an agent; this chip, beside the harness chip, picks the
 * model and effort it starts on. "default" leaves the knob to the harness.
 * The pick rides the launch command (shared/launch-tune), so nothing is typed
 * into a booting pane and nothing becomes the machine's default.
 *
 * Every harness that takes launch flags has one (claude, codex, pi,
 * opencode), listing what its own catalog lists. The effort rows are the
 * PICKED model's levels; a harness with no effort flag (opencode) shows none.
 *
 * Its menu is fixed over the chip, as the harness menu is: the dock clips
 * anything that hangs out of it. A pick keeps the menu open, so both knobs
 * can be set in one visit; outside, Esc or the chip closes it. The host puts
 * the caret in the box on each pick (GlobalPrompt), and the menu rides the
 * keyboard that may bring up (rise-anchor.ts); typing the prompt closes it.
 */

const KNOB_LABEL: Record<LaunchKnob, string> = { model: 'MODEL', effort: 'EFFORT' }
const GAP = 12

export function NewAgentTune({
  offer,
  tune,
  onPick,
  gateway = null
}: {
  offer: LaunchOffer
  /** The pick, already narrowed to what this harness offers (launch-pref.offeredPart / offeredPick). */
  tune: LaunchTune
  onPick: (knob: LaunchKnob, value: string | null) => void
  /** The gateway's catalog, when it is online: a claude agent then picks from the one list. */
  gateway?: NewAgentGateway | null
}): React.JSX.Element {
  const [at, setAt] = useState<RiseAnchor | null>(null)
  useEffect(() => {
    if (!at) return
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') {
          // The menu's Esc: the box keeps the caret a pick put there.
          e.stopPropagation()
        } else if (!typesIntoBox(e)) return
      } else if (e.target instanceof Element && e.target.closest('.cr-prompt-tune-menu, .cr-prompt-tune')) return
      setAt(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [at])

  const menu = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (at) centerCurrent(menu.current)
  }, [at !== null])
  const merged = offer.harness === 'claude' && gateway !== null && gateway.ids.length > 0
  const label = merged ? newAgentLabel(tune, gateway) : (launchTuneLabel(tune) ?? 'default')
  const levels = (model: string | null | undefined): readonly string[] =>
    merged ? effortLevelsFor(model ?? gateway.defaultModel, gateway.models) : effortOffer(offer, model ?? undefined)
  // The effort is kept across a model change where the new model takes it (owner 2026-11-04).
  const pickModel = (value: string | null): void => {
    onPick('model', value)
    if (tune.effort && !levels(value).includes(tune.effort)) onPick('effort', null)
  }
  return (
    <span className="cr-prompt-new">
      <button
        type="button"
        className="cr-prompt-tune"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={`The new agent's model and effort: ${label}`}
        title={merged ? 'The model and effort the new agent starts on — default is the default route' : 'The model and effort the new agent starts on — default leaves them to the harness'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          const next = riseOver(e.currentTarget.getBoundingClientRect(), window.innerHeight, keyboardCoverNow(), 6, topBarBottom())
          setAt((open) => (open ? null : next))
        }}
      >
        {label} ▾
      </button>
      {at && (
        <span
          className="cr-prompt-menu cr-prompt-tune-menu"
          ref={menu}
          role="menu"
          style={riseStyle(at, GAP)}
        >
          {merged && (
            <span className="cr-prompt-tune-knob cr-prompt-tune-models" role="group" aria-label={KNOB_LABEL.model}>
              <span className="cr-prompt-menu-family" role="separator">
                {KNOB_LABEL.model}
              </span>
              <button type="button" role="menuitemradio" aria-checked={!tune.model} onMouseDown={(e) => e.preventDefault()} onClick={() => pickModel(null)}>
                {gateway.defaultModel ? `default · ${shortRoute(gateway.defaultModel)}` : 'default'}
              </button>
              <ModelList look="menu" rows={modelRows(gateway.ids)} current={tune.model ?? null} onPick={pickModel} onMouseDown={(e) => e.preventDefault()} />
            </span>
          )}
          {LAUNCH_KNOBS.filter((knob) => !(merged && knob === 'model'))
            .map((knob) => ({ knob, values: knob === 'model' ? offer.model : levels(tune.model) }))
            .filter(({ values }) => values.length > 0)
            .map(({ knob, values }) => (
              <span key={knob} className="cr-prompt-tune-knob" role="group" aria-label={KNOB_LABEL[knob]}>
                <span className="cr-prompt-menu-family" role="separator">
                  {KNOB_LABEL[knob]}
                </span>
                {[null, ...values].map((value) => (
                  <button
                    key={value ?? 'default'}
                    type="button"
                    role="menuitemradio"
                    aria-checked={(tune[knob] ?? null) === value}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => (knob === 'model' ? pickModel(value) : onPick(knob, value))}
                  >
                    {value ?? 'default'}
                  </button>
                ))}
              </span>
            ))}
        </span>
      )}
    </span>
  )
}
