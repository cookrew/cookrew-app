/**
 * What the record behind a remote card is doing, said so the card can say it.
 *
 * Shared because the renderer renders these as sentences: an empty rail
 * because nothing has happened yet and an empty rail because the door refused
 * must never look the same (remote-card parity contract, P10).
 */
export type DoorTranscriptState =
  /** Nothing asked yet. */
  | { kind: 'starting' }
  | { kind: 'ok'; at: number }
  /** 404 before the door ever answered: this caller has no open session here yet. */
  | { kind: 'no-session' }
  /** 404 or 402 AFTER it had answered: the session is over at the door. */
  | { kind: 'ended' }
  /** 401/403 that a fresh sign-in did not cure. */
  | { kind: 'signed-out' }
  /** Sign-in could not find a door to talk to at all. */
  | { kind: 'not-serving' }
  /** 503: the door is there, its conductor is not, right now. */
  | { kind: 'unavailable' }
  | { kind: 'unreachable'; status: number }

/** The one line a card shows next to its rail for each state; null = say nothing. */
export function doorStateSentence(state: DoorTranscriptState | null, slug: string): string | null {
  if (state === null) return null
  switch (state.kind) {
    case 'starting':
    case 'ok':
      return null
    case 'no-session':
      return 'No session open at this door yet — the first prompt opens one.'
    case 'ended':
      return 'This session has ended at the door. What is here stays readable; nothing new will arrive.'
    case 'signed-out':
      return `The door at @${slug} no longer accepts this sign-in.`
    case 'not-serving':
      return `Nobody is serving @${slug} right now.`
    case 'unavailable':
      return 'The transcript is not available at the door right now — it usually is again shortly.'
    case 'unreachable':
      return 'The transcript could not be read just now. The last good copy is shown.'
  }
}
