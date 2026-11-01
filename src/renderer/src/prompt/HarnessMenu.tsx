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
 *   YOUR TEAMS  a saved team opens a session of its own; + Import a team.
 *   ORCH        the next agent made, either way, leads the crew.
 */

export interface NewMenuActs {
  /** A bare shell is on offer. */
  shell: boolean
  roles: readonly string[]
  teams: readonly string[]
  /** Make a shell, or open a saved team, by its preset name: the old row's chip act. */
  onPreset: (name: string) => void
  onRole: (name: string) => void
  onImportServed?: () => void
  onOrch?: (on: boolean) => void
  /** A card is being made: the acts hold still so one press makes one. */
  making: boolean
}

interface HarnessMenuProps {
  /** Anchored over the chip, fixed: the dock clips anything that hangs out of it. */
  at: RiseAnchor
  harnesses: readonly string[]
  harness: string
  onPick: (name: string) => void
  orch: boolean
  acts?: NewMenuActs
  /** An act was taken: the menu closes. */
  onDone: () => void
}

const GAP = 12

export function HarnessMenu({ at, harnesses, harness, onPick, orch, acts, onDone }: HarnessMenuProps): React.JSX.Element {
  const act = (run: () => void) => () => {
    run()
    onDone()
  }
  const opensNow = acts !== undefined && (acts.shell || acts.roles.length > 0)
  const teamsRow = acts !== undefined && (acts.teams.length > 0 || acts.onImportServed !== undefined)
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
      {acts && teamsRow && (
        <span className="cr-prompt-menu-family" role="separator">
          YOUR TEAMS
        </span>
      )}
      {acts && acts.teams.length > 0 && (
        <span className="cr-prompt-menu-teams">
          {acts.teams.map((name) => (
            <button key={`team:${name}`} type="button" role="menuitem" title={`${name} — opens a session of this team`} disabled={acts.making} onClick={act(() => acts.onPreset(name))}>
              {name}
            </button>
          ))}
        </span>
      )}
      {acts?.onImportServed && (
        <button type="button" role="menuitem" title="Import someone else's served team by its address" onClick={act(acts.onImportServed)}>
          + Import a team
        </button>
      )}
      {acts?.onOrch && (
        <label className="cr-prompt-menu-orch" title="The next agent made leads the crew">
          <input type="checkbox" checked={orch} onChange={(e) => acts.onOrch?.(e.target.checked)} />
          ORCH <small>the next agent leads</small>
        </label>
      )}
    </span>
  )
}
