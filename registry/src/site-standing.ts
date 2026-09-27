import { day } from './site-shell'
import type { V2Seat } from './v2-seats'

/**
 * ONE STANDING, DECIDED ONCE, RENDERED EVERYWHERE.
 *
 * A team page used to have two brains. The seat bar was rendered on the server
 * from what the request held — it knew the reader was @drej and that @drej
 * owned the team — while the LINE under it was rendered blind: SIGNED OUT,
 * "Sign in to open your own session", a gate card offering "🔑 Sign in & open",
 * to everyone, the owner included. And the owner's seat bar had no Open button
 * at all. So an owner, told by half the page to sign in and shown a "Grant a
 * seat" form by the other half, typed their own username into it and granted
 * themselves a seat — at a team the registry already admits them to with no
 * seat (v2-seat-routes: an owner never needs one).
 *
 * This module is the one place that says what a reader IS at a team, and the
 * one place that turns that into what the line says. The seat bar, the line's
 * chip, the strip's sentence and the gate card all read it; nothing on the
 * page has a second source to disagree from. Pure, so every state can be
 * checked without a server, and every sentence can be read in one file.
 */

export type Standing =
  /** Nobody is signed in. The way in is the account sheet. */
  | { kind: 'stranger' }
  /** The reader owns this team. No seat, no charge, at their own door. */
  | { kind: 'owner'; account: string }
  /** The reader holds an active seat here. */
  | { kind: 'seated'; account: string; since: number }
  /** A team that charges nothing admits anyone signed in — registering is the gate. */
  | { kind: 'admitted'; account: string }
  /** Signed in, at a priced team, with no seat yet. */
  | { kind: 'unseated'; account: string; price: string }

/**
 * The reader's standing, from what the request held. The gate order is the
 * same one the seat routes answer in: 401 sign in → the owner → 403 no seat →
 * a free team → the price.
 */
export function standingOf(
  reader: { account: string | null; owner?: boolean; seat?: V2Seat | null },
  door: { handle: string; access: string; priceUsd?: string }
): Standing {
  const account = reader.account
  if (account === null) return { kind: 'stranger' }
  // The server passes `owner` from the same comparison; either is enough, and
  // taking both means a caller that forgot the flag cannot demote an owner.
  if (reader.owner === true || account === door.handle) return { kind: 'owner', account }
  const seat = reader.seat ?? null
  if (seat !== null) return { kind: 'seated', account, since: seat.createdAt }
  if (door.access !== 'paid') return { kind: 'admitted', account }
  return { kind: 'unseated', account, price: door.priceUsd ?? '' }
}

/** What the line needs to know about the door, beyond who is reading. */
export interface LineAt {
  /** `@owner/team`. */
  name: string
  /** The orchestrator's name — the door. */
  orch: string
  handle: string
  live: boolean
  /** On the relay with a seal key, so this page can reach it at all. */
  relayed: boolean
  price: string
}

/** The four things the line's markup says, before any script runs. */
export interface LineFace {
  /** The chip in the bar. Short, upper case, one idea. */
  phase: string
  /** The sentence in the strip. */
  state: string
  gate: { title: string; text: string; button: string; disabled: boolean }
}

const SANDBOX =
  'The door mints a sandboxed workspace for you on the author’s machine, and this terminal becomes its orchestrator’s PTY — the same one a placed card gets.'

/**
 * What the line says to this reader. The door's own condition comes first —
 * offline, or off the relay — because it is true whoever is reading; then the
 * standing decides the rest. Every branch names the reader's situation, and
 * only the stranger's names signing in: a sign-in offered to a signed-in
 * person is the confusion this exists to remove.
 */
export function lineFace(standing: Standing, at: LineAt): LineFace {
  if (!at.live) {
    return {
      phase: 'OFFLINE',
      state: `Nobody is serving ${at.name} right now.`,
      gate: {
        title: 'Not serving right now',
        text: 'The address stays valid. Come back when the owner starts the team again.',
        button: 'Open the line',
        disabled: true
      }
    }
  }
  if (!at.relayed) {
    return {
      phase: 'IN THE APP',
      state: 'This door is not on the relay; open it in the app.',
      gate: {
        title: 'Open it in Cookrew',
        text: 'This door is reached over the owner’s own network, not the relay, so this page cannot carry the line — the app can.',
        button: 'Open the line',
        disabled: true
      }
    }
  }
  switch (standing.kind) {
    case 'stranger':
      return {
        phase: 'SIGNED OUT',
        state: 'Sign in to open your own session at the door.',
        gate: { title: 'Open a session', text: `Sign in with your cookrew.dev account. ${SANDBOX}`, button: '🔑 Sign in & open', disabled: false }
      }
    case 'owner':
      return {
        phase: 'YOURS',
        state: 'Your own team — the line is yours, with no seat and no charge.',
        gate: {
          title: 'Open your own team',
          text: `${at.orch} answers here from your machine. Opening the line mints a sandboxed session of your own, exactly the one a caller gets; nothing you serve is changed by it.`,
          button: 'Open the line',
          disabled: false
        }
      }
    case 'seated':
      return {
        phase: 'SEATED',
        state: `Seat since ${day(standing.since)} · your session continues where you left it.`,
        gate: { title: 'Open a session', text: `Your seat admits you. ${SANDBOX}`, button: 'Open the line', disabled: false }
      }
    case 'admitted':
      return {
        phase: 'SIGNED IN',
        state: 'This team charges nothing — you are signed in, so the line is yours.',
        gate: { title: 'Open a session', text: SANDBOX, button: 'Open the line', disabled: false }
      }
    case 'unseated':
      return {
        phase: 'NO SEAT',
        state: `@${at.handle} lends this team to seated accounts · ${at.price} USD per session.`,
        gate: {
          title: 'A seat first',
          text: `Buy one at the door — ${at.price} USD, charged once when the session starts — or ask @${at.handle} for one; the request reaches every device they have.`,
          button: `Buy a seat · $${at.price}`,
          disabled: false
        }
      }
  }
}
