// Closing a card's terminal, and saying what happened.
//
// Every path that tells someone an agent is gone comes through here: CLOSE
// AGENT, the phone, `cookrew dismiss`, a workspace delete. The card goes only
// after the process has (pane-end.ts). When it will not go, the card stays,
// because the card is the only handle anyone has on it.

export type CloseOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string }

export interface Survivor {
  readonly id: string
  readonly error: string
}

export interface TerminalCloserDeps {
  /** Ends the terminal, throwing when it survives. */
  kill: (id: string) => Promise<void>
  /** Says so where a person will see it. */
  survived: (id: string, why: string) => void
}

export class TerminalCloser {
  private readonly closing = new Map<string, Promise<CloseOutcome>>()

  constructor(private readonly deps: TerminalCloserDeps) {}

  /** One close per terminal at a time: the wait runs seconds, and a second tap must share it. */
  close(id: string): Promise<CloseOutcome> {
    const pending = this.closing.get(id)
    if (pending) return pending
    const run = this.run(id).finally(() => this.closing.delete(id))
    this.closing.set(id, run)
    return run
  }

  private async run(id: string): Promise<CloseOutcome> {
    try {
      await this.deps.kill(id)
      return { ok: true }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      this.deps.survived(id, why)
      return { ok: false, error: why }
    }
  }

  /** Together, so a workspace of stubborn panes waits one deadline rather than one each. */
  async closeAll(ids: readonly string[]): Promise<Survivor[]> {
    const outcomes = await Promise.all(ids.map(async (id) => ({ id, outcome: await this.close(id) })))
    return outcomes.flatMap(({ id, outcome }) => (outcome.ok ? [] : [{ id, error: outcome.error }]))
  }
}
