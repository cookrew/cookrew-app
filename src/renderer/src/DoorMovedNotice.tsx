import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { doorMovedSentence } from '../../shared/door-ownership'
import './door-moved.css'

/**
 * D14 · "alpha moved to Mac Studio. This Mac stopped serving it." — TAKE IT BACK
 *
 * The one card in this app that is NOT a transient toast, and the reason is the
 * failure it replaces: a door that stopped serving with nobody told. Somebody
 * saved the same team on their second Mac, the first one's line was superseded,
 * and the URL they had handed out started answering from a machine with a
 * different canvas on it. Nothing on the first Mac changed, so nothing on the
 * first Mac said anything.
 *
 * WHY IT DOES NOT AGE OUT. Every other toast here reports something that
 * already finished being interesting — an agent hatched, a team forked. This
 * one reports a decision still outstanding: one of two Macs is serving that
 * name, and the owner may have meant the other. A five-second card would be a
 * five-second window on a question that lasts until it is answered.
 *
 * THE TWO ANSWERS ARE BOTH ORDINARY. Taking it back supersedes the other Mac
 * exactly as it superseded this one — the rule is one holder, not first-come —
 * and letting it go simply dismisses the sentence. Neither changes the URL:
 * @drej/alpha points at whoever holds it.
 */

interface MovedDoor {
  slug: string
  team: string
  by: string
}

export function DoorMovedNotice(): React.JSX.Element | null {
  const [doors, setDoors] = useState<readonly MovedDoor[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    // Asked for AND subscribed: a door can move while this window is closed or
    // reloading, and a notice that existed only as an event would be one the
    // owner never saw.
    void cookrew()
      .servingMoved?.()
      .then((held) => setDoors(held.map((d) => ({ slug: d.slug, team: d.team, by: d.by }))))
      .catch(() => undefined)
    return cookrew().onServingMoved?.((door) =>
      setDoors((prev) => [...prev.filter((held) => held.slug !== door.slug), door])
    )
  }, [])

  const forget = (slug: string): void => {
    setDoors((prev) => prev.filter((held) => held.slug !== slug))
    void cookrew().servingMovedClear?.(slug).catch(() => undefined)
  }

  const takeBack = (slug: string): void => {
    setBusy(slug)
    setFailed(null)
    void cookrew()
      .servingTakeBack?.(slug)
      .then((back) => {
        setBusy(null)
        if (back?.ok) {
          setDoors((prev) => prev.filter((held) => held.slug !== slug))
          return
        }
        // Named rather than swallowed: the door did not come back, and a card
        // that quietly stayed put would read as a button that does nothing.
        setFailed(slug)
      })
      .catch(() => {
        setBusy(null)
        setFailed(slug)
      })
  }

  if (doors.length === 0) return null
  return (
    <div className="door-moved" role="alert">
      {doors.map((door) => (
        <div className="door-moved-card" key={door.slug}>
          <span className="door-moved-g" aria-hidden="true">
            ◫
          </span>
          <div className="door-moved-body">
            <span className="door-moved-s">{doorMovedSentence(door.team, door.by)}</span>
            {failed === door.slug && (
              <span className="door-moved-bad">
                It did not come back — {door.by} may be offline, or cookrew.dev unreachable.
              </span>
            )}
            <div className="door-moved-row">
              <button
                type="button"
                className="door-moved-b primary"
                disabled={busy === door.slug}
                onClick={() => takeBack(door.slug)}
              >
                {busy === door.slug ? 'TAKING IT BACK…' : 'TAKE IT BACK'}
              </button>
              <button type="button" className="door-moved-b" onClick={() => forget(door.slug)}>
                LEAVE IT
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
