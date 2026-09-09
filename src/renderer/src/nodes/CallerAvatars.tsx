import { useState } from 'react'
import {
  CALLER_AVATAR_LIMIT,
  callerSentence,
  endSessionSentence,
  type SeatedCaller,
  type ServedCallersRow
} from '../../../shared/seats'
import { cookrew } from '../api'
import { useServedCallers } from '../served-callers-store'

/**
 * D7 — THE CALLERS AT A SERVED DOOR, on the card that is the door.
 *
 * This is the ONLY place another person appears on the owner's canvas, and it
 * is deliberately small: initials on a coloured circle, a hover that names the
 * person, and a click that offers to end their session. No avatars from the
 * network, no presence beacon, no message — a door that could show a stranger's
 * picture would be a door that fetches a stranger's URL.
 *
 * WHICH CARD. The row rides the ORCH card of the team being served — the card
 * an owner recognises as "the thing I put up". It is matched by the orch's NAME
 * in the served team, because that is the only link the renderer has between a
 * card and a service without teaching it the whole serving registry. The one
 * false positive that could produce is the SAME orch card inside a caller's
 * own minted sandbox (a fork of the team, so same name), and it is excluded by
 * id: a card that IS somebody's conductor is their crew, not the door.
 */

/** The callers that belong on one card, or none. Pure — the whole matching rule. */
export function callersForCard(
  rows: readonly ServedCallersRow[],
  card: { id: string; name: string; orch: boolean }
): readonly SeatedCaller[] {
  if (!card.orch) return []
  const matched = rows.filter((row) => row.orchName !== null && row.orchName === card.name)
  if (matched.length === 0) return []
  const callers = matched.flatMap((row) => [...row.callers])
  // A caller's own conductor card carries the same orch name (their sandbox is
  // a fork of the team). It is their crew, not the door, so it wears no faces.
  if (callers.some((caller) => caller.conductorId === card.id)) return []
  return callers
}

/** What the row draws: the first few, and how many did not fit. */
export function avatarRow(callers: readonly SeatedCaller[]): {
  shown: readonly SeatedCaller[]
  overflow: number
} {
  const shown = callers.slice(0, CALLER_AVATAR_LIMIT)
  return { shown, overflow: Math.max(0, callers.length - shown.length) }
}

/** Two letters, from a username that has no display name at a door. */
export function callerInitials(username: string): string {
  const name = username.replace(/^@/, '')
  const letters = name.replace(/[^a-z0-9]/gi, '')
  return (letters.slice(0, 2) || '?').toUpperCase()
}

/**
 * A stable colour per person, so the same face is the same colour every time.
 *
 * Derived from the username rather than assigned from a palette in arrival
 * order: two callers who join in a different order after a restart must not
 * swap colours, because the colour is how an owner recognises them at a glance
 * before reading anything.
 */
export function callerHue(username: string): number {
  let hash = 0
  for (const char of username) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

/**
 * Live callers at this desktop's doors, pushed from main. Lives in
 * served-callers-store.ts now — one IPC subscription shared by every card,
 * where this used to be one per mounted card — and is re-exported here so the
 * name and the return type stay where callers found them.
 */
export { useServedCallers }

export function CallerAvatars({
  callers,
  onEnd
}: {
  callers: readonly SeatedCaller[]
  onEnd?: (caller: SeatedCaller) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null)
  if (callers.length === 0) return null
  const { shown, overflow } = avatarRow(callers)
  const picked = callers.find((caller) => caller.sessionId === open) ?? null

  return (
    <span className="cr-callers" aria-label={`${callers.length} at this door`}>
      {shown.map((caller) => (
        <button
          key={caller.sessionId}
          type="button"
          className="cr-caller nodrag"
          style={{ ['--caller-hue' as string]: String(callerHue(caller.username)) }}
          title={callerSentence(caller)}
          aria-label={callerSentence(caller)}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(open === caller.sessionId ? null : caller.sessionId)
          }}
        >
          {callerInitials(caller.username)}
        </button>
      ))}
      {overflow > 0 && (
        <span
          className="cr-caller cr-caller-more"
          title={callers
            .slice(CALLER_AVATAR_LIMIT)
            .map((caller) => `@${caller.username}`)
            .join(', ')}
        >
          +{overflow}
        </span>
      )}
      {picked && (
        <span className="cr-caller-menu nodrag" role="dialog" aria-label={`@${picked.username}`}>
          <span className="cr-caller-why">{endSessionSentence(picked)}</span>
          <button
            type="button"
            className="gs-revoke"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(null)
              onEnd?.(picked)
            }}
          >
            END SESSION
          </button>
        </span>
      )}
    </span>
  )
}

/**
 * The card-head row, wired to main: it reads the pushed callers, matches this
 * card, and ends a session through the owner-only serving IPC.
 *
 * Split from the presentational component above so the matching rule and the
 * drawing are each testable without the other, and so a card that is not a
 * door renders exactly the nothing it did before.
 */
export function CardCallerAvatars({
  card
}: {
  card: { id: string; name: string; orch: boolean }
}): React.JSX.Element | null {
  const rows = useServedCallers()
  const callers = callersForCard(rows, card)
  if (callers.length === 0) return null
  return (
    <CallerAvatars
      callers={callers}
      onEnd={(caller) => {
        void cookrew()
          .servingEnd?.(caller.sessionId)
          .catch(() => undefined)
      }}
    />
  )
}
