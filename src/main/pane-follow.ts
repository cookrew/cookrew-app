// A CARD ON SCREEN FOLLOWS ITS PANE.
//
// A terminal with no transcript (a Shell, a scraped harness) knows only what a
// mirror told it, and a mirror is dropped by a workspace switch and absent after
// a relaunch, on purpose: a board of cards must not be a board of attached
// clients. So the card froze on the last frame it had, over a pane still running
// (box test 2, bug 8: 494 shown, 513 true).
//
// Reading a pane costs one capture, not an attach, so this reads the panes of the
// cards on screen and publishes only what changed. Single-flight, and bounded per
// pass, so a wall of Shells takes turns rather than a burst of forks.

export interface PaneFollowDeps {
  /** Cards on screen that have no mirror and no record of their own. */
  candidates: () => readonly string[]
  /** The ids whose pane is running. Rejects when the backend cannot be read. */
  live: (ids: readonly string[]) => Promise<ReadonlySet<string>>
  /** The pane's text, or null when it could not be read. */
  capture: (id: string) => Promise<string | null>
  publish: (id: string, text: string) => void
  /** A pane this was following has ended. */
  gone: (id: string) => void
  perPass?: number
}

const PER_PASS = 6

export class PaneFollower {
  private readonly shown = new Map<string, string>()
  private readonly perPass: number
  private busy = false
  private cursor = 0

  constructor(private readonly deps: PaneFollowDeps) {
    this.perPass = deps.perPass ?? PER_PASS
  }

  /** One pass. A pass already running is the pass. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.pass()
    } finally {
      this.busy = false
    }
  }

  forget(id: string): void {
    this.shown.delete(id)
  }

  private async pass(): Promise<void> {
    const candidates = this.deps.candidates()
    this.dropUnfollowed(candidates)
    if (candidates.length === 0) return
    let live: ReadonlySet<string>
    try {
      live = await this.deps.live(candidates)
    } catch {
      return // Blindness is not absence.
    }
    for (const id of candidates) {
      if (!live.has(id) && this.shown.has(id)) {
        this.shown.delete(id)
        this.deps.gone(id)
      }
    }
    for (const id of this.nextTurn(candidates.filter((id) => live.has(id)))) await this.read(id)
  }

  /** A card that got a mirror, or left the screen, is not a pane that ended. */
  private dropUnfollowed(candidates: readonly string[]): void {
    const followed = new Set(candidates)
    for (const id of this.shown.keys()) if (!followed.has(id)) this.shown.delete(id)
  }

  private nextTurn(ids: readonly string[]): readonly string[] {
    if (ids.length <= this.perPass) return ids
    const turn = Array.from({ length: this.perPass }, (_, i) => ids[(this.cursor + i) % ids.length])
    this.cursor = (this.cursor + this.perPass) % ids.length
    return turn
  }

  private async read(id: string): Promise<void> {
    let text: string | null
    try {
      text = await this.deps.capture(id)
    } catch {
      return
    }
    if (text === null || this.shown.get(id) === text) return
    this.shown.set(id, text)
    this.deps.publish(id, text)
  }
}
