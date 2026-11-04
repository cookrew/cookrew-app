/**
 * herdr's word on an agent, checked against the pane before the tracker hears it.
 *
 * herdr guesses a Claude pane's state from its screen whenever Claude's own
 * hooks are not holding it, and it reads the `/model` picker as working, then
 * as a question (a numbered menu). A mirrorless card shows herdr's word as-is,
 * so the picker painted working → waiting → working → done over a command that
 * ran no turn (status eval r5, phone, 2 of 3 tries); a tracked agent took the
 * "blocked" as a missed question (healBlocked).
 *
 * So a positive phase is applied only once the pane has been read and does not
 * show the agent's own UI for a slash command (uiCommandOpen). While that
 * refusal holds and herdr keeps saying the same thing, the pane is read again
 * every RECHECK_MS: herdr pushes only on a change, so a refusal taken in the
 * instant before a real prompt's echo landed would otherwise stick.
 *
 * A pane that cannot be read leaves herdr's word standing, and a null (idle,
 * done, gone) always passes at once: retracting is never wrong.
 *
 * WAITING, the pane is the only place a mirrorless card can read the menu from
 * (shared/wait-choice.ts), so it is handed on (`menu`), and read again while
 * the word holds: a first read may catch a menu half drawn, and an answer given
 * through a mirror since gone leaves the next question up with no word from herdr.
 */
import { uiCommandOpen } from '../shared/turn'
import type { TurnPhase } from '../shared/turn'

const RECHECK_MS = 2000
/** A picker left open for minutes is not worth a pane read every 2 s forever. */
const MAX_RECHECKS = 150
/** A menu settling just after herdr's word, then the pace of the watch, for half an hour of one word. */
const MENU_SETTLE_MS = 1500
const MENU_WATCH_MS = 6000
const MAX_MENU_READS = 300

export interface BackendPhaseGateDeps {
  /** The pane's recent text, or null when it cannot be read. */
  read: (terminalId: string) => Promise<string | null>
  /** herdr's current word for the terminal, as a phase (null = nothing to show). */
  current: (terminalId: string) => TurnPhase | null
  /** Hand the checked phase on (TurnTracker.observeBackendPhase). */
  apply: (terminalId: string, phase: TurnPhase | null, agent: boolean) => void
  /** Read the menu of a terminal waiting on the human. */
  menu?: (terminalId: string) => Promise<void>
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export interface BackendPhaseGate {
  observe: (terminalId: string, phase: TurnPhase | null, agent: boolean) => void
}

export function createBackendPhaseGate(deps: BackendPhaseGateDeps): BackendPhaseGate {
  const schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms))
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  /** A number per observation, never reused, so a read that lands late is dropped. */
  const seq = new Map<string, number>()
  let observed = 0
  const timers = new Map<string, unknown>()
  /** The last word seen per terminal: the oracle sweep repeats it, and a repeat is no news. */
  const last = new Map<string, string>()

  const clearTimer = (terminalId: string): void => {
    const timer = timers.get(terminalId)
    if (timer === undefined) return
    cancel(timer)
    timers.delete(terminalId)
  }

  /** Read the waiting pane again, as long as the same word holds. */
  const watchMenu = (terminalId: string, mine: number, ms: number, reads = 0): void => {
    timers.set(
      terminalId,
      schedule(() => {
        timers.delete(terminalId)
        if (seq.get(terminalId) !== mine || deps.current(terminalId) !== 'waiting') return
        const next = (): void => {
          if (seq.get(terminalId) === mine && reads < MAX_MENU_READS) watchMenu(terminalId, mine, MENU_WATCH_MS, reads + 1)
        }
        void Promise.resolve(deps.menu?.(terminalId)).then(next, next)
      }, ms)
    )
  }

  const check = (terminalId: string, phase: TurnPhase, agent: boolean, mine: number, tries = 0): void => {
    void deps.read(terminalId).then(
      (screen) => {
        if (seq.get(terminalId) !== mine) return
        if (screen === null || !uiCommandOpen(screen)) {
          deps.apply(terminalId, phase, agent)
          if (phase === 'waiting' && deps.menu) {
            void deps.menu(terminalId).catch(() => undefined)
            watchMenu(terminalId, mine, MENU_SETTLE_MS)
          }
          return
        }
        deps.apply(terminalId, null, agent)
        if (tries >= MAX_RECHECKS) return
        timers.set(
          terminalId,
          schedule(() => {
            timers.delete(terminalId)
            if (seq.get(terminalId) !== mine || deps.current(terminalId) !== phase) return
            check(terminalId, phase, agent, mine, tries + 1)
          }, RECHECK_MS)
        )
      },
      () => {
        if (seq.get(terminalId) === mine) deps.apply(terminalId, phase, agent)
      }
    )
  }

  return {
    observe: (terminalId, phase, agent) => {
      // A retraction passes at once and forgets the terminal: a read still in
      // flight finds no sequence and is dropped, and nothing outlives a card.
      if (phase === null) {
        clearTimer(terminalId)
        seq.delete(terminalId)
        last.delete(terminalId)
        deps.apply(terminalId, null, agent)
        return
      }
      // The same word again is no news: a check in flight or a re-read timer
      // already covers it.
      const word = `${phase}|${agent}`
      if (last.get(terminalId) === word) return
      last.set(terminalId, word)
      clearTimer(terminalId)
      observed += 1
      const mine = observed
      seq.set(terminalId, mine)
      // A tracked agent is checked too: a detach hands the stored phase to a
      // card with no mirror, so nothing unchecked may be stored.
      if (!agent) {
        deps.apply(terminalId, phase, agent)
        return
      }
      check(terminalId, phase, agent, mine)
    }
  }
}
