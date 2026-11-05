/**
 * WHO IS TYPING IN THIS PANE, kept by terminal id.
 *
 * Two facts that have to outlive any one PtySession, because a session is only
 * this process's view of a pane: a `detach` drops it and a later attach makes a
 * new one while the same `cookrew login` goes on reading in the same pane.
 *
 * SEALED. A hidden prompt is open here (login-cli.ts): keys are delivered and
 * announced to nobody (PtySession · sealInput), and nothing but a keyboard may
 * write. A person answers a password prompt; `cookrew ask`, a routine, a
 * dispatch and Sous do not, and an ordinary ask that happened to land there
 * would be sent to cookrew.dev as a password attempt.
 *
 * DRIVEN. The last thing to write here was not a keyboard. This is what tells a
 * Shell card a person is using from one an agent is operating with
 * `cookrew ask "Shell" --raw`: the caller then has a real tty and no claude
 * ancestor, so every check on the caller passes, and only the keys differ. A
 * flag and not a timestamp, because a stamp that ages out is beaten by
 * `sleep 31; cookrew logout`. Only a keystroke clears it, so a keyboard that
 * never passes through this app (SSH attached straight to the pane) cannot, and
 * that person is told to use a fresh Shell card.
 *
 * `cookrew ui type` IS NOT A KEYBOARD EITHER, and looks exactly like one: it
 * injects real input events into the window, which reach a focused pane as
 * ordinary keys. It cannot say which pane, so keys that arrive within a moment
 * of an injection count as driven. A person typing in that same moment is
 * refused and has only to press a key again, which is the safe way round.
 *
 * Memory only, on purpose: a restart ends every conversation that a seal could
 * belong to, and it costs a driven pane nothing worse than one keystroke.
 */

export const SEALED_REFUSAL = 'this pane is at a hidden prompt, and only a keyboard may answer it'

/** Long enough for injected keys to come back through the renderer, on a slow day. */
const WINDOW_KEYS_MS = 2_000

export class PaneInputs {
  private seals: ReadonlyMap<string, ReadonlySet<symbol>> = new Map()
  private drivenPanes: ReadonlySet<string> = new Set()
  private windowDrivenAt = Number.NEGATIVE_INFINITY
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Seal this pane. Answers the release, which is safe to call twice. */
  seal(terminalId: string): () => void {
    const seal = Symbol('sealed input')
    this.setSeals(terminalId, new Set([...(this.seals.get(terminalId) ?? []), seal]))
    return () => {
      const left = [...(this.seals.get(terminalId) ?? [])].filter((held) => held !== seal)
      this.setSeals(terminalId, new Set(left))
    }
  }

  private setSeals(terminalId: string, held: ReadonlySet<symbol>): void {
    const others = [...this.seals].filter(([id]) => id !== terminalId)
    this.seals = new Map(held.size > 0 ? [...others, [terminalId, held]] : others)
  }

  sealed(terminalId: string): boolean {
    return this.seals.has(terminalId)
  }

  /** Something that is not a keyboard wrote here, with nothing to refuse it. */
  noteDriven(terminalId: string): void {
    this.drivenPanes = new Set([...this.drivenPanes, terminalId])
  }

  /** May something that is not a keyboard write here? If so, it now has. */
  drive(terminalId: string): boolean {
    if (this.sealed(terminalId)) return false
    this.noteDriven(terminalId)
    return true
  }

  /** May input be injected into the window? It can land in any pane, so a seal anywhere refuses. */
  driveWindow(): boolean {
    if (this.seals.size > 0) return false
    this.windowDrivenAt = this.now()
    return true
  }

  /** A key came from the window: a person's, unless an injection just went in. */
  noteWindowKey(terminalId: string): void {
    if (this.now() - this.windowDrivenAt < WINDOW_KEYS_MS) this.noteDriven(terminalId)
    else this.noteKeyboard(terminalId)
  }

  /** A person pressed a key. */
  noteKeyboard(terminalId: string): void {
    if (!this.drivenPanes.has(terminalId)) return
    this.drivenPanes = new Set([...this.drivenPanes].filter((id) => id !== terminalId))
  }

  driven(terminalId: string): boolean {
    return this.drivenPanes.has(terminalId)
  }
}

/** The one the process shares: panes outlive sessions, not the process. */
export const paneInputs = new PaneInputs()
