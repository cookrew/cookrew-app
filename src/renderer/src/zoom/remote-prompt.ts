import { hasWordsRow } from '../../../shared/wait-choice'
import { replyCall, type CardCall, type RemoteCard } from './remote-machine'
import type { RemotePlace } from './remote-machine-store'

/**
 * THE BAR'S BOX INSIDE ANOTHER MACHINE (owner 2026-11-12: "this part should be
 * handed back to the bar; the whole interaction should stay the same"). One box,
 * folded into its face at the bar's end as on this machine (RemotePrompt.tsx);
 * what it says and where its words go are decided here:
 *
 *   an agent's card open (or one of its items)  the words go to that agent
 *   anywhere else in that machine                 the words start a new agent
 *                                                 in the workspace stood in,
 *                                                 else the one in front there
 *
 * Every send is a call on that machine (watch-routes.ts): its watch routes.
 */

export type RemoteBoxTarget =
  | { readonly kind: 'agent'; readonly card: RemoteCard }
  | { readonly kind: 'new'; readonly workspace: { readonly id: string; readonly name: string } }
  | { readonly kind: 'none' }

/** Who the box talks to, from where the view stands there and what it last read. */
export function remoteBoxTarget(place: RemotePlace, front: { id: string; name: string } | null, cards: readonly RemoteCard[] | null): RemoteBoxTarget {
  if (!place.machine) return { kind: 'none' }
  if (place.agent) {
    const card = cards?.find((one) => one.id === place.agent?.id) ?? null
    return card ? { kind: 'agent', card } : { kind: 'none' }
  }
  const workspace = place.workspace ?? front
  return workspace ? { kind: 'new', workspace } : { kind: 'none' }
}

/** The box's own key in that machine's drafts (remote-machine-store.ts · remoteDraft): the words typed before stay. */
export function remoteBoxDraftKey(target: RemoteBoxTarget): string | null {
  if (target.kind === 'agent') return target.card.id
  if (target.kind === 'new') return `new:${target.workspace.id}`
  return null
}

/** A menu with no row for words: the box waits for a row to be picked on the card. */
export const remoteBoxShut = (target: RemoteBoxTarget): boolean =>
  target.kind === 'agent' && target.card.choice !== null && !hasWordsRow(target.card.choice)

export function remoteBoxPlaceholder(target: RemoteBoxTarget, machine: string): string {
  if (target.kind === 'new') return `Start a new agent in ${target.workspace.name} on ${machine}…`
  if (target.kind === 'none') return `Asking ${machine}…`
  const { card } = target
  if (remoteBoxShut(target)) return `Answer ${card.name}’s menu on the card first`
  if (card.choice) return `Type the answer for ${card.name} on ${machine}…`
  return `Reply to ${card.name} on ${machine}…`
}

/** The call the words make, or null when they make none (no words, a menu that takes none, nobody to send to). */
export function remoteBoxCall(target: RemoteBoxTarget, words: string): CardCall | null {
  const text = words.trim()
  if (!text) return null
  if (target.kind === 'agent') return replyCall(target.card, text)
  if (target.kind === 'new') return { route: `api/watch/new?seat=${encodeURIComponent(target.workspace.id)}`, body: { text } }
  return null
}
