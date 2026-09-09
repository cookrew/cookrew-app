import { useEffect, useState } from 'react'
import { currentBrowser } from './browser-family'
import { localNetworkGate, subscribeLocalNetwork } from './local-network-gate'
import type { LocalNetworkState } from './local-network'
import { attemptSentence, PERMISSION_COPY } from './path-copy'
import { pathAttempts, subscribePathAttempts, type PathAttempts } from './path-attempts'

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
 *
 * THE HEADER LINE IS THE CONDITION EVERY ROW RAN UNDER, and it was the piece
 * missing from the screenshot that started this: four candidates refused
 * before they connected mean one thing in a Chrome that has been denied the
 * local network and something else entirely in a Safari that has no such
 * permission to deny. Browser and permission, once, above the rows — never a
 * full user-agent string, which is a fingerprint and belongs on no screen that
 * gets pasted into a chat.
 */
export function PathWhy(): React.JSX.Element | null {
  const [state, setState] = useState<PathAttempts>(() => pathAttempts())
  const [permission, setPermission] = useState<LocalNetworkState>(() => localNetworkGate())

  useEffect(() => subscribePathAttempts(setState), [])
  useEffect(() => subscribeLocalNetwork(setPermission), [])

  if (state.attempts.length === 0) return null

  return (
    <details className="cr-path-why">
      <summary className="cr-path-why-head">Why this path</summary>
      <p className="cr-path-why-env">{`${currentBrowser()} · ${PERMISSION_COPY[permission]}`}</p>
      <ul className="cr-path-why-list">
        {state.attempts.map((attempt) => (
          <li
            key={attempt.name}
            className={`cr-path-why-row${attempt.chosen ? ' cr-path-why-chosen' : ''}`}
          >
            <span className="cr-path-why-name">{attempt.name}</span>
            <span className="cr-path-why-what">{attemptSentence(attempt)}</span>
            <span className="cr-path-why-plane">{attempt.plane}</span>
            {/* The browser's own words, and only where there are any. A reader
                who has been told the kind sometimes wants the exception — it is
                the difference between filing a bug and guessing at one. */}
            {attempt.detail && <span className="cr-path-why-detail">{attempt.detail}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}
