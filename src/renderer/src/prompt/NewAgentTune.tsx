import { useEffect, useState } from 'react'
import { keyboardCoverNow, riseOver, riseStyle, typesIntoBox, type RiseAnchor } from './rise-anchor'
import { LAUNCH_KNOBS, launchTuneLabel, type LaunchKnob, type LaunchOffer, type LaunchTune } from '../../../shared/launch-tune'

/**
 * THE NEW AGENT'S TUNE CHIP (owner, 2026-11-01). With nobody targeted the
 * prompt box makes an agent; this chip, beside the harness chip, picks the
 * model and effort it starts on. "default" leaves the knob to the harness.
 * The pick rides the launch command (shared/launch-tune), so nothing is typed
 * into a booting pane and nothing becomes the machine's default.
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
  onPick
}: {
  offer: LaunchOffer
  /** The pick, already narrowed to what this harness offers (launch-pref.offeredPart). */
  tune: LaunchTune
  onPick: (knob: LaunchKnob, value: string | null) => void
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

  const label = launchTuneLabel(tune) ?? 'default'
  return (
    <span className="cr-prompt-new">
      <button
        type="button"
        className="cr-prompt-tune"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={`The new agent's model and effort: ${label}`}
        title="The model and effort the new agent starts on — default leaves them to the harness"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          const next = riseOver(e.currentTarget.getBoundingClientRect(), window.innerHeight, keyboardCoverNow())
          setAt((open) => (open ? null : next))
        }}
      >
        {label} ▾
      </button>
      {at && (
        <span
          className="cr-prompt-menu cr-prompt-tune-menu"
          role="menu"
          style={riseStyle(at, GAP)}
        >
          {LAUNCH_KNOBS.map((knob) => (
            <span key={knob} className="cr-prompt-tune-knob" role="group" aria-label={KNOB_LABEL[knob]}>
              <span className="cr-prompt-menu-family" role="separator">
                {KNOB_LABEL[knob]}
              </span>
              {[null, ...offer[knob]].map((value) => (
                <button
                  key={value ?? 'default'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={(tune[knob] ?? null) === value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(knob, value)}
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
