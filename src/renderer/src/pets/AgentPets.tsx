import { useEffect, useMemo, useState } from 'react'
import { cookrew } from '../api'
import { useActivitiesSnapshot } from '../activity-thumb-store'
import { useRoster } from '../agent-registry'
import { buildAgentRows, type AgentRow } from '../agent-rows'
import { AgentAvatar } from '../nodes/AgentAvatar'
import { inkStatusOfRow } from '../zoom/ink-status'
import { InkAvatar } from '../zoom/InkAvatar'
import { TurnView } from '../nodes/TurnView'
import { useStreamTails } from '../stream/use-stream-tails'
import { checkpointViewModel, isEmptyTurnView } from '../turn-view-model'
import type { WorkspaceState } from '../../../shared/model'
import { petMax, pickPets, type Pet, type PetMood } from './pet-pick'
import { useOfToolLine, type ToolUse } from '../../../shared/use-signal'
import { PetTroop, type CardControls } from './PetTroop'

/**
 * THE AGENTS AS PETS — the right-hand troop (PetTroop.tsx).
 *
 * The stage's agent column is retired: this is where the crew lives now,
 * over every page. pet-pick.ts says who rides along (whoever needs you, then
 * whoever is working, then what finished lately). A card is the agent's latest
 * turn as the board card shows it (the same TurnView: headline, the ask, the
 * tool calls, the status or the reply) and a box to prompt it from right
 * there (the first click); the second click is the full transcript.
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

export function AgentPets({
  workspace,
  workspaceId,
  onOpen
}: {
  workspace: WorkspaceState | null
  workspaceId: string | null
  /** The full transcript (App: the stage, with it picked). */
  onOpen: (id: string) => void
}): React.JSX.Element | null {
  const { rows, now } = usePetRows(workspace)
  const troop = useMemo(() => pickPets(rows, { workspaceId, now, max: petMax(window.innerWidth) }), [rows, workspaceId, now])
  const byId = useMemo(() => new Map([...troop.pets, ...troop.more].map((pet) => [pet.row.id, pet])), [troop])
  const member = (pet: Pet) => {
    const use = petUse(pet)
    return {
      id: pet.row.id,
      className: use ? `${pet.mood} using` : pet.mood,
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
      members={troop.pets.map(member)}
      more={troop.more.map(member)}
      onOpen={onOpen}
      cardClass={(id) => byId.get(id)?.mood ?? ''}
      cardLabel={(id) => `${byId.get(id)?.row.name ?? 'Agent'}'s latest turn`}
      renderCard={(id, controls) => {
        const pet = byId.get(id)
        return pet ? <AgentCard pet={pet} now={now} controls={controls} /> : null
      }}
    />
  )
}

/** One agent's card: its latest turn, and a box to prompt it. */
function AgentCard({ pet, now, controls }: { pet: Pet; now: number; controls: CardControls }): React.JSX.Element {
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
            <span>{agoLabel(row.lastActivityAt, now)}</span>
            {row.turnCount > 0 && <span>{row.turnCount} turns</span>}
          </span>
        </span>
        <button type="button" className="cr-pet-card-open" onClick={controls.open} title="Open the full transcript (or click its face again)">
          OPEN
        </button>
        <button type="button" className="cr-pet-card-x" onClick={controls.close} aria-label="Close">
          ×
        </button>
      </div>
      <div className="cr-pet-card-turn ags-turn">
        {turn ? <TurnView model={turn} /> : <span className="cr-pet-card-empty">{row.brief ?? 'Nothing said yet.'}</span>}
      </div>
      {sent !== null && (
        <div className="cr-pet-card-sent" role="status">
          sent — {sent.length > 80 ? `${sent.slice(0, 80)}…` : sent}
        </div>
      )}
      <form
        className="cr-pet-card-ask"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <textarea
          value={draft}
          rows={1}
          placeholder={`Prompt ${row.name}…`}
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
        <button type="submit" className="cr-pet-card-send" disabled={draft.trim().length === 0} aria-label="Send">
          ➜
        </button>
      </form>
    </>
  )
}
