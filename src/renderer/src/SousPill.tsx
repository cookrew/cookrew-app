import { CrIcon } from './icons'

/**
 * Sous, at the top of the stage: the words as they are heard while ⌘ is
 * held, then what Sous said back, then nothing. One element, three moods,
 * so the eye always finds it in the same place.
 */
export function SousPill({
  listening,
  partial,
  reply
}: {
  listening: boolean
  partial: string
  /** The last spoken reply, shown briefly after a sentence; null = hidden. */
  reply: { text: string; refused: boolean } | null
}): React.JSX.Element | null {
  if (listening) {
    return (
      <div className="sous-pill listening" role="status" aria-live="polite">
        <CrIcon name="mic" />
        <span className="sous-pill-text">{partial.trim() ? partial : 'Listening…'}</span>
      </div>
    )
  }
  if (reply && reply.text) {
    return (
      <div className={`sous-pill reply${reply.refused ? ' refused' : ''}`} role="status" aria-live="polite">
        <span className="sous-pill-text">{reply.text}</span>
      </div>
    )
  }
  return null
}
