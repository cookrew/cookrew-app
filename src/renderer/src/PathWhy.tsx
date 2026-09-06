import { useEffect, useState } from 'react'
import { ATTEMPT_COPY } from './path-copy'
import { pathAttempts, subscribePathAttempts, type PathAttempt, type PathAttempts } from './path-attempts'

/**
 * WHY THIS PATH — one closed row of evidence under the badge's sentence.
 *
 * It exists because the badge is a conclusion. "RELAY" is true and it is not
 * an answer: the reader wants to know whether their Mac is asleep, whether
 * their browser refused, or whether something on the Wi-Fi answered and could
 * not prove it was theirs — three different problems with three different next
 * steps, all currently spelled with the same five letters.
 *
 * CLOSED BY DEFAULT, and a `<details>` rather than a modal, because it is
 * reference material: nobody opens it until the badge has already surprised
 * them. Open it costs a tap; closed it costs one line.
 *
 * IT SHOWS WHAT WAS TRIED, NOT WHAT EXISTS. A tier that was never reached
 * because a nearer one settled the race has no rows here, and that is correct
 * — listing the tailnet as untried would read as a failure.
 */
export function PathWhy(): React.JSX.Element | null {
  const [state, setState] = useState<PathAttempts>(() => pathAttempts())

  useEffect(() => subscribePathAttempts(setState), [])

  if (state.attempts.length === 0) return null

  return (
    <details className="cr-path-why">
      <summary className="cr-path-why-head">Why this path</summary>
      <ul className="cr-path-why-list">
        {state.attempts.map((attempt) => (
          <li
            key={attempt.name}
            className={`cr-path-why-row${attempt.chosen ? ' cr-path-why-chosen' : ''}`}
          >
            <span className="cr-path-why-name">{attempt.name}</span>
            <span className="cr-path-why-what">{whatHappened(attempt)}</span>
            <span className="cr-path-why-plane">{attempt.plane}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The one sentence per row, with the measurement folded in where there is one.
 *
 * `answered` without a time would throw away the only number in the panel that
 * explains an ordering, and `unverified` WITH one is deliberate: an address
 * that answered in 4 ms and could not prove itself is the exact signature of
 * somebody else's machine on this Wi-Fi, and the speed is the tell.
 */
const whatHappened = (attempt: PathAttempt): string => {
  const said = ATTEMPT_COPY[attempt.outcome]
  if (attempt.ms === null) return said
  return attempt.outcome === 'answered' ? `${said} in ${attempt.ms} ms` : `${said} — ${attempt.ms} ms`
}
