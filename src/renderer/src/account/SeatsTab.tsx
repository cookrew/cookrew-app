import { useCallback, useEffect, useState } from 'react'
import type { AccountRefusal } from '../../../shared/account-v2'
import {
  seatSentence,
  servingSummary,
  type HeldSeatRow,
  type SeatFace,
  type SeatsSurface,
  type ServingSeatsRow
} from '../../../shared/seats'
import { cookrew } from '../api'
import { ACCOUNT_COPY, refusalSentence } from './account-store'

/**
 * D4's fifth tab — SEATS & TEAMS.
 *
 * Two kinds of row, and the difference between them is which side of a door
 * this account is standing on:
 *
 *   SERVING · COOKREW Alpha · paid $1 · 3 seats taken    GRANT A SEAT
 *   SEAT    · @mira/review-bench · granted by @mira      OPEN
 *
 * The SERVING rows are teams THIS Mac is serving, with the seats cookrew.dev
 * holds for them; the SEAT rows are seats this person holds at other people's
 * doors, and OPEN is a deep link to that team's page rather than anything
 * local — a seat is not canvas access (the architecture note's last line about
 * what a guest may see), so there is nothing here for it to open.
 *
 * A ROW SURVIVES A REGISTRY THAT WILL NOT ANSWER. Serving is a fact this Mac
 * knows on its own; the seat count is not. So the team is listed either way and
 * the sentence explains which half is missing — the alternative reads as "you
 * stopped serving", which would be a lie told by an outage.
 */

const GRANT_LABEL = 'GRANT A SEAT'

/** The seat rows under one team, oldest first — the order they were given in. */
export function activeSeats(row: ServingSeatsRow): readonly SeatFace[] {
  return [...row.seats]
    .filter((seat) => seat.endedAt === undefined)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** The SERVING row's own line. Split out so the sentence is testable alone. */
export function servingLine(row: ServingSeatsRow): string {
  return `${row.title} · ${servingSummary({ ...row, seats: activeSeats(row) })}`
}

/** The SEAT row's line: whose door, and how the seat was come by. */
export function heldLine(row: HeldSeatRow): string {
  return `${row.seat.team} · ${seatSentence(row.seat)}`
}

/** What a team with no published name can be told, in one sentence. */
export const UNPUBLISHED =
  'This door is not on cookrew.dev yet, so it has no seats. Serve it on the relay first.'

export function SeatsTab({ username }: { username: string }): React.JSX.Element {
  const [surface, setSurface] = useState<SeatsSurface | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [granting, setGranting] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback((): void => {
    const call = cookrew().accountSeats
    if (!call) {
      setSurface({ serving: [], held: [] })
      return
    }
    void call()
      .then((result) => {
        if (result.ok) setSurface(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => {
        console.error('seats tab:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }, [username])

  useEffect(load, [load])

  /** Redraw ONE team after a grant or an END, rather than the whole tab. */
  const refresh = (slug: string): void => {
    const call = cookrew().accountTeamSeats
    if (!call) return
    void call(slug)
      .then((result) => {
        if (!result.ok) return
        setSurface((prior) =>
          prior === null
            ? prior
            : {
                ...prior,
                serving: prior.serving.map((row) =>
                  row.slug === slug ? { ...row, seats: result.value, error: undefined } : row
                )
              }
        )
      })
      .catch(() => undefined)
  }

  const grant = (slug: string): void => {
    const call = cookrew().accountGrantSeat
    const name = typed.trim()
    if (!call || name.length === 0) return
    setBusy(true)
    setError(null)
    void call({ slug, username: name })
      .then((result) => {
        setBusy(false)
        if (!result.ok) {
          setError(seatRefusal(result.reason, result.message, name))
          return
        }
        setGranting(null)
        setTyped('')
        refresh(slug)
      })
      .catch(() => {
        setBusy(false)
        setError('Something went wrong on this side. Try again.')
      })
  }

  const end = (slug: string, id: string): void => {
    const call = cookrew().accountEndSeat
    if (!call) return
    void call({ slug, id })
      .then((result) => {
        if (!result.ok) {
          setError(seatRefusal(result.reason, result.message, username))
          return
        }
        refresh(slug)
      })
      .catch(() => undefined)
  }

  const serving = surface?.serving ?? []
  const held = surface?.held ?? []
  const empty = surface !== null && serving.length === 0 && held.length === 0

  return (
    <section className="cr-acct-pane" aria-label="Seats and teams">
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <ul className="cr-acct-devices">
        {serving.map((row) => (
          <li key={row.serviceId} className="cr-acct-device">
            <span className="cr-acct-kind">SERVING</span>
            <span className="cr-acct-seclabel">{servingLine(row)}</span>
            {row.team === null ? (
              <span className="cr-acct-secstate">NOT PUBLISHED</span>
            ) : (
              <button className="gs-revoke" onClick={() => setGranting(row.slug)}>
                {GRANT_LABEL}
              </button>
            )}
            {row.error && (
              <p className="gs-consequence">
                {refusalSentence(row.error, undefined, username)}
              </p>
            )}
            {row.team === null && <p className="gs-consequence">{UNPUBLISHED}</p>}
            {granting === row.slug && (
              <p className="gs-consequence">
                <input
                  className="cr-acct-grant-name"
                  aria-label={`Grant a seat at ${row.title} by username`}
                  placeholder="username"
                  value={typed}
                  autoFocus
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') grant(row.slug)
                    if (e.key === 'Escape') setGranting(null)
                  }}
                />{' '}
                <button className="gs-revoke" disabled={busy} onClick={() => grant(row.slug)}>
                  GRANT
                </button>
              </p>
            )}
            <ul className="cr-acct-seats">
              {activeSeats(row).map((seat) => (
                <li key={seat.id} className="cr-acct-seat">
                  <span className="cr-acct-seclabel">
                    @{seat.account} · {seatSentence(seat)}
                  </span>
                  <button className="gs-revoke" onClick={() => end(row.slug, seat.id)}>
                    END
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}

        {held.map((row) => (
          <li key={row.seat.id} className="cr-acct-device">
            <span className="cr-acct-kind">SEAT</span>
            <span className="cr-acct-seclabel">{heldLine(row)}</span>
            <OpenTeam url={row.url} />
          </li>
        ))}

        {empty && <li className="gs-dim">{ACCOUNT_COPY.NO_SEATS}</li>}
      </ul>
    </section>
  )
}

/**
 * OPEN goes to the team's page at cookrew.dev, in a real browser.
 *
 * Not into the canvas: a seat is not canvas access, and the page is where the
 * seat, the terms and the line all are. The anchor fallback matters on the
 * phone, where a real https navigation is what deep-links the native app.
 */
function OpenTeam({ url }: { url: string }): React.JSX.Element {
  const bridged = cookrew().openExternal
  if (!bridged) {
    return (
      <a className="gs-revoke" href={url} target="_blank" rel="noopener noreferrer">
        OPEN
      </a>
    )
  }
  return (
    <button className="gs-revoke" onClick={() => void bridged(url).catch(() => undefined)}>
      OPEN
    </button>
  )
}

/**
 * The seat refusals, in words. Everything an account call can say is already
 * phrased by `refusalSentence`; these two are new to seats and are the ones a
 * person mistypes their way into.
 */
export function seatRefusal(
  reason: AccountRefusal,
  message: string | undefined,
  subject: string
): string {
  if (reason === 'not_found') {
    return `Nobody has claimed @${subject}. Check the spelling — a seat goes to a person, not a name.`
  }
  if (reason === 'already_seated') return `@${subject} already has a seat here.`
  return refusalSentence(reason, message, subject)
}
