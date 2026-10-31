import { useEffect, useMemo, useState } from 'react'
import { cookrew } from '../api'
import { useActivitiesSnapshot } from '../activity-thumb-store'
import { useRoster } from '../agent-registry'
import { buildAgentRows, type AgentRow } from '../agent-rows'
import { AgentAvatar } from '../nodes/AgentAvatar'
import { inkStatusOfRow } from '../zoom/ink-status'
import { InkAvatar } from '../zoom/InkAvatar'
import { useStreamTails } from '../stream/use-stream-tails'
import { checkpointViewModel, isEmptyTurnView } from '../turn-view-model'
import type { WorkspaceState } from '../../../shared/model'
import { petMax, pickPets, type Pet, type PetMood } from './pet-pick'
import { useOfToolLine, type ToolUse } from '../../../shared/use-signal'
import { dockedOrder } from './pet-dock'
import { PetTroop, type CardControls } from './PetTroop'
import type { AttachmentIndex } from '../terminal-attachments'
import { AgentLatest } from '../zoom/AgentLatest'
import { Counts, Page } from '../zoom/ZoomParts'
import { itemViewOf, type ItemView } from '../zoom/zoom-model'
import '../zoom/zoom.css'
import '../zoom/agent-card.css'

/**
 * THE AGENTS AS PETS — the right-hand troop (PetTroop.tsx).
 *
 * The stage's agent column is retired: this is where the crew lives now,
 * over every page. pet-pick.ts says who rides along (whoever needs you, then
 * whoever is working, then what finished lately). A card (the first click) is
 * the zoom's agent card, one card in one look (zoom/agent-card.css): its face
 * and state, its latest turn (zoom/AgentLatest.tsx: headline, the ask, the
 * tool it runs, the live status), three of its browsers and notes, and a box
 * to prompt it; the second click is the full transcript.
 */

const SENT_MS = 4000
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

const agoLabel = (since: number, now: number): string => {
  const mins = Math.max(0, Math.floor((now - since) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
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

/** Thumbnails a card shows, as the zoom card does. */
const CARD_THUMBS = 3

export function AgentPets({
  workspace,
  workspaceId,
  attachIndex,
  onOpen,
  dock = null
}: {
  workspace: WorkspaceState | null
  workspaceId: string | null
  /** Each agent's browsers and notes, for the card's counts and thumbnails. */
  attachIndex: AttachmentIndex
  /** The full transcript (App: the stage, with it picked); an item id opens the item. */
  onOpen: (id: string) => void
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
      cardClass={(id) => `ag-ink ag-card ${byId.get(id)?.mood ?? ''}`}
      cardLabel={(id) => `${byId.get(id)?.row.name ?? 'Agent'}'s latest turn`}
      renderCard={(id, controls) => {
        const pet = byId.get(id)
        if (!pet) return null
        const carried = attachIndex.get(id) ?? []
        return (
          <AgentCard
            pet={pet}
            now={now}
            controls={controls}
            carried={carried.flatMap((a) => itemViewOf(a.node, [id]) ?? [])}
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

/** One agent's card: its face and state, its latest turn, its browsers and notes, and a box to prompt it. */
function AgentCard({
  pet,
  now,
  controls,
  carried,
  onItem
}: {
  pet: Pet
  now: number
  controls: CardControls
  /** Its browsers and notes, newest wire first. */
  carried: readonly ItemView[]
  onItem: (id: string) => void
}): React.JSX.Element {
  const { row, mood } = pet
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  // One tail, for the card on screen, when the live tracker has nothing (after
  // a restart): the stage's board-wide read is gone with its column.
  const live = row.turn && !isEmptyTurnView(row.turn) ? row.turn : null
  const tails = useStreamTails(useMemo(() => (live ? [] : [row.id]), [live, row.id]))
  const turn = live ?? checkpointViewModel(tails[row.id] ?? null)

  useEffect(() => {
    if (sent === null) return
    const timer = setTimeout(() => setSent(null), SENT_MS)
    return () => clearTimeout(timer)
  }, [sent])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    // The same two writes the voice bar makes: the words, then Enter on its
    // own, so the Mac's submit sees a paste and its Enter (raw-input-queue.ts).
    cookrew().ptyInput(row.id, text)
    cookrew().ptyInput(row.id, '\r')
    setDraft('')
    controls.draft('')
    setSent(text)
  }

  return (
    <>
      <div className="cr-pet-card-head">
        <span className="cr-pet-card-face">
          <AgentAvatar id={row.id} orch={row.orch} status={inkStatusOfRow(row.phase, row.unread)} preset={row.preset} />
        </span>
        <span className="cr-pet-card-who">
          <span className="cr-pet-card-name">{row.name}</span>
          <span className="cr-pet-card-meta">
            <span className={`cr-pet-mood ${mood}`}>{MOOD_WORD[mood]}</span>
            <Counts browsers={carried.filter((i) => i.kind === 'browser').length} notes={carried.filter((i) => i.kind === 'note').length} none="" />
            <span title={row.turnCount > 0 ? `${row.turnCount} turns` : undefined}>{agoLabel(row.lastActivityAt, now)}</span>
          </span>
        </span>
        <button type="button" className="cr-pet-card-open" onClick={controls.open} title="Open the full transcript (or click its face again)">
          OPEN
        </button>
        <button type="button" className="cr-pet-card-x" onClick={controls.close} aria-label="Close">
          ×
        </button>
      </div>
      <AgentLatest turn={turn} fallback={row.brief ?? 'Nothing said yet.'} />
      {carried.length > 0 && (
        <div className="ag-thumbs">
          {carried.slice(0, CARD_THUMBS).map((item) => (
            <button key={item.id} type="button" className={`zv-th ag-thumb ${item.kind}`} title={item.title} aria-label={`Open ${item.kind}: ${item.title}`} onClick={() => onItem(item.id)}>
              <Page item={item} big />
            </button>
          ))}
        </div>
      )}
      {sent !== null && (
        <div className="cr-pet-card-sent" role="status">
          sent — {sent.length > 80 ? `${sent.slice(0, 80)}…` : sent}
        </div>
      )}
      <form
        className="ag-reply"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <textarea
          value={draft}
          rows={1}
          placeholder={`Reply to ${row.name}…`}
          aria-label={`Prompt ${row.name}`}
          onChange={(event) => {
            setDraft(event.target.value)
            controls.draft(event.target.value)
          }}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line; an IME's Enter is its own.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
        />
        <button type="submit" disabled={draft.trim().length === 0} aria-label="Send">
          ➜
        </button>
      </form>
    </>
  )
}
