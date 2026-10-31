import { useEffect, useMemo, useState } from 'react'
import { useActivitiesSnapshot } from '../activity-thumb-store'
import { useRoster } from '../agent-registry'
import { buildAgentRows, type AgentRow } from '../agent-rows'
import { inkStatusOfRow } from '../zoom/ink-status'
import { InkAvatar } from '../zoom/InkAvatar'
import type { WorkspaceState } from '../../../shared/model'
import { petMax, pickPets, type Pet, type PetMood } from './pet-pick'
import { useOfToolLine, type ToolUse } from '../../../shared/use-signal'
import { dockedOrder } from './pet-dock'
import { PetTroop } from './PetTroop'

/**
 * THE AGENTS AS PETS — the right-hand troop (PetTroop.tsx).
 *
 * The stage's agent column is retired: this is where the crew lives now,
 * over every page. pet-pick.ts says who rides along (whoever needs you, then
 * whoever is working, then what finished lately). A click opens the agent's
 * card, and that card is the zoom view's own (ZoomParts · AgentNode): ONE
 * card instance in the app (owner, 2026-10-31), never a second drawn here.
 * The pet hands the click to `onCard`; the card's face then opens the full
 * transcript, as it does from the crew.
 */

const TICK_MS = 30_000

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

/** The crew, from the roster and the live tracker only: no board-wide tail read. */
const usePetRows = (workspace: WorkspaceState | null): { rows: AgentRow[]; now: number } => {
  const roster = useRoster()
  const activities = useActivitiesSnapshot()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  const briefs = useMemo(() => {
    const out: Record<string, string> = {}
    for (const node of workspace?.nodes ?? []) if (node.kind === 'terminal' && node.brief) out[node.id] = node.brief
    return out
  }, [workspace])
  const rows = useMemo(() => {
    const built = buildAgentRows({ roster, activities, now, briefs })
    return [...built.live, ...built.quiet]
  }, [roster, activities, now, briefs])
  return { rows, now }
}

export function AgentPets({
  workspace,
  workspaceId,
  onOpen,
  onCard,
  dock = null
}: {
  workspace: WorkspaceState | null
  workspaceId: string | null
  /** The full transcript (App: the stage, with it picked). */
  onOpen: (id: string) => void
  /** Its card: the zoom view's own, the one instance (App · zoomStore.openCard). */
  onCard: (id: string) => void
  /**
   * A full view is up: the troop attaches to it (pet-dock.ts), without the
   * agent the panel shows, the agents its browser or note is wired to first.
   */
  dock?: { readonly exclude: string | null; readonly first: readonly string[] } | null
}): React.JSX.Element | null {
  const { rows, now } = usePetRows(workspace)
  const troop = useMemo(() => pickPets(rows, { workspaceId, now, max: petMax(window.innerWidth) }), [rows, workspaceId, now])
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
      onCard={onCard}
    />
  )
}
