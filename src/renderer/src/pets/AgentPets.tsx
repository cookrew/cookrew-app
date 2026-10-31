import { useMemo } from 'react'
import { inkStatusOfRow } from '../zoom/ink-status'
import { InkAvatar } from '../zoom/InkAvatar'
import type { AttachmentIndex } from '../terminal-attachments'
import type { Crew } from '../stage/crew-rows'
import { AgentCard } from '../zoom/AgentCard'
import { agentViewOf, itemViewOf } from '../zoom/zoom-model'
import { petMax, pickPets, type Pet, type PetMood } from './pet-pick'
import { useOfToolLine, type ToolUse } from '../../../shared/use-signal'
import { dockedOrder } from './pet-dock'
import { PetTroop } from './PetTroop'

/**
 * THE AGENTS AS PETS — the right-hand troop (PetTroop.tsx).
 *
 * The stage's agent column is retired: this is where the crew lives now,
 * over every page. pet-pick.ts says who rides along (whoever needs you, then
 * whoever is working, then what finished lately), out of THE crew, the one
 * list the crew view draws too (stage/crew-rows.ts · useCrew, owner
 * 2026-11-01): the same agents, the same states, the same count behind "+N".
 * A click floats the agent's card beside its face (zoom/AgentCard.tsx, the
 * crew view's card, built from the same AgentView), only while it is open; a
 * second click, or its OPEN, is the agent's full view.
 */

const MOOD_WORD: Record<PetMood, string> = { needs: 'needs you', working: 'working', done: 'done', asleep: 'resting' }

/**
 * A working agent's current USE, read off its newest tool line: a pet whose
 * agent is driving a phone, a Mac, a browser it reached on its own, or a
 * board on the bench wears it (shared/use-signal.ts · useOfToolLine). That is
 * the whole of what Cookrew can show for a use it does not carry — the place
 * is unknown, the fact is not. Cookrew's own cards get a cursor instead.
 */
const petUse = (pet: Pet): ToolUse | null => {
  if (pet.mood !== 'working') return null
  const tools = pet.row.turn?.tools ?? []
  const newest = tools[tools.length - 1]
  return newest ? useOfToolLine(newest) : null
}

export function AgentPets({
  crew,
  attachIndex,
  onOpen,
  onDelete,
  dock = null
}: {
  /** THE crew, read once in App: the same list the crew view draws. */
  crew: Crew
  /** Each agent's browsers and notes, for its card's counts and thumbnails. */
  attachIndex: AttachmentIndex
  /** The full view: an agent's, or a browser's or note's (App · zoomToNode). */
  onOpen: (id: string) => void
  /** Remove an agent, the confirm dialog first (App · requestClose): the card's ×, as on the crew card. */
  onDelete?: (id: string) => void
  /**
   * A full view is up: the troop attaches to it (pet-dock.ts), without the
   * agent the panel shows, the agents its browser or note is wired to first.
   */
  dock?: { readonly exclude: string | null; readonly first: readonly string[] } | null
}): React.JSX.Element | null {
  const { now } = crew
  const troop = useMemo(() => pickPets(crew.crew, { now, max: petMax(window.innerWidth) }), [crew.crew, now])
  const byId = useMemo(() => new Map([...troop.pets, ...troop.more].map((pet) => [pet.row.id, pet])), [troop])
  // In a full view the column is the demo's: the card on the panel is not in it, the ones wired to it lead.
  const column = useMemo(() => {
    if (!dock) return { pets: troop.pets, more: troop.more, dim: new Set<string>() }
    const all = [...troop.pets, ...troop.more].map((pet) => ({ id: pet.row.id, pet }))
    const order = dockedOrder(all, dock)
    const count = troop.pets.filter((pet) => pet.row.id !== dock.exclude).length
    return { pets: order.members.slice(0, count).map((m) => m.pet), more: order.members.slice(count).map((m) => m.pet), dim: order.dim }
  }, [troop, dock])
  const member = (pet: Pet) => {
    const use = petUse(pet)
    return {
      id: pet.row.id,
      className: `${use ? `${pet.mood} using` : pet.mood}${column.dim.has(pet.row.id) ? ' dim' : ''}`,
      name: pet.row.name,
      label: `${pet.row.name}, ${MOOD_WORD[pet.mood]}${use ? `, using ${use.use === 'hardware' ? 'hardware' : `a ${use.use}`} (${use.via})` : ''}`,
      face: (
        <>
          {/* The navigator's ink face, so the side group and the full view are one family. */}
          <InkAvatar id={pet.row.id} preset={pet.row.preset} orch={pet.row.orch} status={inkStatusOfRow(pet.row.phase, pet.row.unread)} />
          {use && (
            <span className="cr-pet-use" data-use={use.use} aria-hidden="true">
              {use.via}
            </span>
          )}
        </>
      )
    }
  }
  return (
    <PetTroop
      side="right"
      storageKey="cookrew.pets.agents"
      label="agents"
      members={column.pets.map(member)}
      more={column.more.map(member)}
      dockable={dock !== null}
      onOpen={onOpen}
      cardClass={(id) => `ag-ink ag-card ${byId.get(id)?.mood ?? ''}`}
      cardLabel={(id) => `${byId.get(id)?.row.name ?? 'Agent'}'s card`}
      renderCard={(id, controls) => {
        const pet = byId.get(id)
        if (!pet) return null
        const items = (attachIndex.get(id) ?? []).flatMap((a) => itemViewOf(a.node, [id]) ?? [])
        return (
          <AgentCard
            agent={agentViewOf(pet.row, attachIndex)}
            items={items}
            onOpen={controls.open}
            onDelete={
              onDelete
                ? () => {
                    controls.close()
                    onDelete(id)
                  }
                : undefined
            }
            onDraft={controls.draft}
            onItem={(itemId) => {
              controls.close()
              onOpen(itemId)
            }}
          />
        )
      }}
    />
  )
}
