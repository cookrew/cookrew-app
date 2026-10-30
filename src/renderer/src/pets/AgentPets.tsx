import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cookrew } from '../api'
import { useActivitiesSnapshot } from '../activity-thumb-store'
import { useRoster } from '../agent-registry'
import { buildAgentRows, type AgentRow } from '../agent-rows'
import { AgentAvatar } from '../nodes/AgentAvatar'
import { TurnView } from '../nodes/TurnView'
import { useStreamTails } from '../stream/use-stream-tails'
import type { TurnPhase } from '../../../shared/turn'
import type { WorkspaceState } from '../../../shared/model'
import { cardPlacement, clampSpot, petHome, pickPets, readSpot, type Pet, type PetMood, type PetSpot } from './pet-pick'
import './pets.css'

/**
 * THE AGENTS AS PETS — small round avatars that ride on top of every page.
 *
 * The canvas, the stage, the levels and the board each show the crew their
 * own way, and each hides it the moment you are somewhere else. The troop is
 * the one place the agents stay in sight whatever page is open: a handful of
 * round faces sitting over the dock (pet-pick.ts says which), each in its
 * mood — needs you, working, done, asleep.
 *
 * Rest a pointer on one and its card opens beside it: the latest turn, as the
 * board card shows it (the same TurnView: headline, the ask, the tool calls,
 * the status or the reply), and a box to prompt it from right there. Click it
 * and its full transcript opens (the stage, with it picked). On a phone, a
 * tap opens the card and the card's OPEN goes to the transcript. Drag the
 * troop anywhere; it remembers where. The grip tucks it into one coin.
 */

const SPOT_KEY = 'cookrew.pets.spot'
const TUCKED_KEY = 'cookrew.pets.tucked'
const ENTER_MS = 220
const LEAVE_MS = 320
const DRAG_PX = 5
const SENT_MS = 4000
const TICK_MS = 30_000

const AVATAR: Record<PetMood, TurnPhase> = { needs: 'waiting', working: 'thinking', done: 'replied', asleep: 'idle' }
const MOOD_WORD: Record<PetMood, string> = { needs: 'needs you', working: 'working', done: 'done', asleep: 'resting' }

const stored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
const store = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Private mode: the troop forgets where it sat, and that is all.
  }
}

const agoLabel = (since: number, now: number): string => {
  const mins = Math.max(0, Math.floor((now - since) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** The crew of the loaded workspace, with a tail read for the one card that is open. */
const usePetRows = (workspace: WorkspaceState | null, openId: string | null): { rows: AgentRow[]; now: number } => {
  const roster = useRoster()
  const activities = useActivitiesSnapshot()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  // One tail, for the card on screen: the stage already reads the board's;
  // a second board-wide read here would double the phone's polling.
  const tails = useStreamTails(useMemo(() => (openId ? [openId] : []), [openId]))
  const briefs = useMemo(() => {
    const out: Record<string, string> = {}
    for (const node of workspace?.nodes ?? []) if (node.kind === 'terminal' && node.brief) out[node.id] = node.brief
    return out
  }, [workspace])
  const rows = useMemo(() => {
    const built = buildAgentRows({ roster, activities, checkpoints: tails, now, briefs })
    return [...built.live, ...built.quiet]
  }, [roster, activities, tails, now, briefs])
  return { rows, now }
}

export function AgentPets({
  workspace,
  workspaceId,
  onOpen
}: {
  workspace: WorkspaceState | null
  workspaceId: string | null
  /** The full transcript: the page decides how (App opens the stage with it picked). */
  onOpen: (row: AgentRow) => void
}): React.JSX.Element | null {
  const [openId, setOpenId] = useState<string | null>(null)
  const { rows, now } = usePetRows(workspace, openId)
  const [expanded, setExpanded] = useState(false)
  const [tucked, setTucked] = useState(() => stored(TUCKED_KEY) === '1')
  const [spot, setSpot] = useState<PetSpot>(() => readSpot(stored(SPOT_KEY), petHome(window.innerWidth)))
  const troopRef = useRef<HTMLDivElement>(null)
  const petRefs = useRef(new Map<string, HTMLButtonElement>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerType = useRef<string>('mouse')
  const drag = useRef<{ x: number; y: number; spot: PetSpot; moved: boolean; id: number } | null>(null)
  const swallowClick = useRef(false)
  const [pinned, setPinned] = useState(false)

  const troop = useMemo(() => pickPets(rows, { workspaceId, now }), [rows, workspaceId, now])
  const shown: readonly Pet[] = tucked ? troop.pets.slice(0, 1) : expanded ? [...troop.pets, ...troop.more] : troop.pets
  const openPet = openId ? ([...troop.pets, ...troop.more].find((pet) => pet.row.id === openId) ?? null) : null

  const stopTimer = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => () => stopTimer(), [])
  const closeSoon = (): void => {
    stopTimer()
    if (pinned) return
    timer.current = setTimeout(() => setOpenId(null), LEAVE_MS)
  }
  const close = useCallback((): void => {
    stopTimer()
    setPinned(false)
    setOpenId(null)
  }, [])

  // The troop stays on screen when the window shrinks or the phone turns.
  useEffect(() => {
    const keep = (): void => {
      const el = troopRef.current
      if (!el) return
      setSpot((at) => clampSpot(at, el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
    }
    keep()
    window.addEventListener('resize', keep)
    return () => window.removeEventListener('resize', keep)
  }, [shown.length, tucked])

  useEffect(() => {
    if (!openId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, close])

  // A tap anywhere else puts the card away — unless it holds a draft, which
  // a stray tap must not throw out.
  const draftRef = useRef('')
  useEffect(() => {
    if (!openId) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (!target || troopRef.current?.contains(target) || document.querySelector('.cr-pet-card')?.contains(target)) return
      if (draftRef.current.trim().length > 0) return
      close()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [openId, close])

  if (troop.pets.length === 0) return null

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointerType.current = event.pointerType
    if (event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, spot, moved: false, id: event.pointerId }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const at = drag.current
    if (!at || at.id !== event.pointerId) return
    const dx = event.clientX - at.x
    const dy = event.clientY - at.y
    if (!at.moved && Math.hypot(dx, dy) < DRAG_PX) return
    if (!at.moved) {
      at.moved = true
      close()
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const el = troopRef.current
    if (!el) return
    setSpot(clampSpot({ right: at.spot.right - dx, bottom: at.spot.bottom - dy }, el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const at = drag.current
    drag.current = null
    if (!at?.moved) return
    swallowClick.current = true
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const el = troopRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      store(SPOT_KEY, JSON.stringify({ right: Math.round(window.innerWidth - rect.right), bottom: Math.round(window.innerHeight - rect.bottom) }))
    }
  }

  const clickPet = (pet: Pet): void => {
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    if (tucked) {
      setTucked(false)
      store(TUCKED_KEY, '0')
      return
    }
    // A mouse already saw the card on its way in; a finger has not.
    if (pointerType.current === 'mouse') {
      close()
      onOpen(pet.row)
      return
    }
    if (openId === pet.row.id) close()
    else {
      setPinned(true)
      setOpenId(pet.row.id)
    }
  }

  const tuck = (): void => {
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    const next = !tucked
    setTucked(next)
    setExpanded(false)
    close()
    store(TUCKED_KEY, next ? '1' : '0')
  }

  const toggleMore = (): void => {
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    setExpanded((on) => !on)
  }

  const hidden = troop.more.length + (tucked ? troop.pets.length - 1 : 0)
  const anchor = openId ? (petRefs.current.get(openId) ?? null) : null

  return createPortal(
    <>
      <div
        ref={troopRef}
        className={`cr-pets${tucked ? ' tucked' : ''}${expanded ? ' expanded' : ''}`}
        style={{ right: spot.right, bottom: spot.bottom }}
        role="toolbar"
        aria-label="Agents"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => void (drag.current = null)}
        onPointerLeave={(event) => event.pointerType === 'mouse' && closeSoon()}
      >
        <button type="button" className="cr-pets-grip" title={tucked ? 'Show the agents' : 'Tuck the agents away (drag to move)'} aria-label={tucked ? 'Show the agents' : 'Tuck the agents away'} onClick={tuck}>
          <span aria-hidden="true">⋮⋮</span>
        </button>
        {shown.map((pet) => (
          <button
            key={pet.row.id}
            ref={(el) => {
              if (el) petRefs.current.set(pet.row.id, el)
              else petRefs.current.delete(pet.row.id)
            }}
            type="button"
            className={`cr-pet ${pet.mood}${openId === pet.row.id ? ' open' : ''}`}
            aria-label={`${pet.row.name}, ${MOOD_WORD[pet.mood]}`}
            aria-expanded={openId === pet.row.id}
            title={tucked ? undefined : pet.row.name}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'mouse' || tucked || drag.current?.moved) return
              stopTimer()
              const id = pet.row.id
              timer.current = setTimeout(() => setOpenId(id), openId ? 0 : ENTER_MS)
            }}
            // The keyboard's way in; a tap focuses too, and opens on its click.
            onFocus={(event) => !tucked && event.currentTarget.matches(':focus-visible') && setOpenId(pet.row.id)}
            onClick={() => clickPet(pet)}
          >
            <AgentAvatar phase={AVATAR[pet.mood]} preset={pet.row.preset} />
            {pet.mood === 'asleep' && <span className="cr-pet-z" aria-hidden="true">z</span>}
            {tucked && hidden > 0 && <span className="cr-pet-count">{hidden + 1}</span>}
          </button>
        ))}
        {!tucked && troop.more.length > 0 && (
          <button type="button" className="cr-pet more" title={expanded ? 'Fewer agents' : `${troop.more.length} more agents`} onClick={toggleMore}>
            {expanded ? '–' : `+${troop.more.length}`}
          </button>
        )}
      </div>
      {openPet && anchor && (
        <PetCard
          key={openPet.row.id}
          pet={openPet}
          now={now}
          anchor={anchor}
          onEnter={stopTimer}
          onLeave={closeSoon}
          onPin={setPinned}
          onDraft={(text) => void (draftRef.current = text)}
          onClose={close}
          onOpen={() => {
            close()
            onOpen(openPet.row)
          }}
        />
      )}
    </>,
    document.body
  )
}

/** One pet's card: its latest turn, and a box to prompt it. */
function PetCard({
  pet,
  now,
  anchor,
  onEnter,
  onLeave,
  onPin,
  onDraft,
  onClose,
  onOpen
}: {
  pet: Pet
  now: number
  anchor: HTMLElement
  onEnter: () => void
  onLeave: () => void
  /** Typing holds the card open: a pointer that wanders off must not take the draft with it. */
  onPin: (pinned: boolean) => void
  onDraft: (text: string) => void
  onClose: () => void
  onOpen: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const { row, mood } = pet

  useLayoutEffect(() => {
    const card = ref.current
    if (!card) return
    const measure = (): void => {
      const a = anchor.getBoundingClientRect()
      const c = card.getBoundingClientRect()
      setPlace(cardPlacement(a, { width: c.width, height: c.height }, { width: window.innerWidth, height: window.innerHeight }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(card)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [anchor])

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
    onDraft('')
    setSent(text)
    onPin(false)
  }

  return (
    <div
      ref={ref}
      className={`cr-pet-card ${mood}${place?.above === false ? ' below' : ''}`}
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden', left: 0, top: 0 }}
      role="dialog"
      aria-label={`${row.name}'s latest turn`}
      onPointerEnter={onEnter}
      onPointerLeave={(event) => event.pointerType === 'mouse' && onLeave()}
    >
      <div className="cr-pet-card-head">
        <span className="cr-pet-card-face">
          <AgentAvatar phase={AVATAR[mood]} preset={row.preset} />
        </span>
        <span className="cr-pet-card-who">
          <span className="cr-pet-card-name">{row.name}</span>
          <span className="cr-pet-card-meta">
            <span className={`cr-pet-mood ${mood}`}>{MOOD_WORD[mood]}</span>
            <span>{agoLabel(row.lastActivityAt, now)}</span>
            {row.turnCount > 0 && <span>{row.turnCount} turns</span>}
          </span>
        </span>
        <button type="button" className="cr-pet-card-open" onClick={onOpen} title="Open the full transcript">
          OPEN
        </button>
        <button type="button" className="cr-pet-card-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="cr-pet-card-turn ags-turn">
        {row.turn ? <TurnView model={row.turn} /> : <span className="cr-pet-card-empty">{row.brief ?? 'Nothing said yet.'}</span>}
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
            onDraft(event.target.value)
            onPin(event.target.value.length > 0)
          }}
          onFocus={() => onPin(true)}
          onBlur={() => onPin(draft.length > 0)}
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
    </div>
  )
}

