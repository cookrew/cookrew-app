import { SHELL_PRESET } from './harness-pref'
import { riseStyle, type RiseAnchor } from './rise-anchor'

/**
 * THE ＋ MENU (owner, 2026-11-01: "add a Shell and the button on the left can retire").
 * The dock's TERMINAL button is retired, so everything its preset row held
 * lives here, under the box's harness chip:
 *
 *   harnesses   a pick: the next prompt makes an agent on it (sticky).
 *   OPEN NOW    a bare Shell and each saved role: made at once, as the row's
 *               chips did. A shell takes no prompt (typed into zsh, the words
 *               would run as a command), so it is never the box's harness.
 *               The window picker too: a card, not a harness (use/SourcePicker.tsx).
 *
 * YOUR TEAMS (+ Import a team) and the ORCH switch were here too, and are
 * retired (owner, 2026-11-03).
 */

export interface NewMenuActs {
  /** A bare shell is on offer. */
  shell: boolean
  roles: readonly string[]
  /** Make a shell by its preset name: the old row's chip act. */
  onPreset: (name: string) => void
  onRole: (name: string) => void
  /** Open the window picker; absent where this client cannot. */
  onSource?: () => void
  /** A card is being made: the acts hold still so one press makes one. */
  making: boolean
}

interface HarnessMenuProps {
  /** Anchored over the chip, fixed: the dock clips anything that hangs out of it. */
  at: RiseAnchor
  harnesses: readonly string[]
  harness: string
  onPick: (name: string) => void
  acts?: NewMenuActs
  /** An act was taken: the menu closes. */
  onDone: () => void
}

const GAP = 12

export function HarnessMenu({ at, harnesses, harness, onPick, acts, onDone }: HarnessMenuProps): React.JSX.Element {
  const act = (run: () => void) => () => {
    run()
    onDone()
  }
  const opensNow = acts !== undefined && (acts.shell || acts.roles.length > 0 || acts.onSource !== undefined)
  return (
    <span
      className="cr-prompt-menu cr-prompt-new-menu"
      role="menu"
      style={riseStyle(at, GAP)}
    >
      {harnesses.map((name) => (
        <button key={name} type="button" role="menuitemradio" aria-checked={name === harness} onClick={() => onPick(name)}>
          {name}
        </button>
      ))}
      {acts && opensNow && (
        <span className="cr-prompt-menu-family" role="separator">
          OPEN NOW
        </span>
      )}
      {acts?.shell && (
        <button type="button" role="menuitem" title="A plain terminal, opened now: it takes no prompt" disabled={acts.making} onClick={act(() => acts.onPreset(SHELL_PRESET))}>
          {SHELL_PRESET}
        </button>
      )}
      {acts?.roles.map((name) => (
        <button key={`role:${name}`} type="button" role="menuitem" title={`Role · boots its harness with the “${name}” prompt`} disabled={acts.making} onClick={act(() => acts.onRole(name))}>
          {name} <small>role</small>
        </button>
      ))}
      {acts?.onSource && (
        <button type="button" role="menuitem" title="Show a window or a whole screen as a card" onClick={act(acts.onSource)}>
          Window or screen
        </button>
      )}
    </span>
  )
}
