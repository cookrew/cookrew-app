// THE WORLD'S MODEL — board rows and workspaces in, places and towers out.
//
// Pure, so the two decisions that make this map worth flying through can be
// tested without a GPU.
//
// WHY THERE IS A THIRD AXIS AT ALL. A screen is two-dimensional and a
// projection does not add pixels, so depth only earns its place when it
// CARRIES something. Here it carries time: the workspace you touched last is
// at your feet and the ones you have left alone recede, with the gap in the
// road proportional to the gap in your attention. Fog takes the far end, so
// "I cannot see it any more" and "I have not looked at it in a week" are the
// same sentence.
//
// The other two axes are the crew: an island's width is how many agents live
// there, and a tower's height is how many turns that agent has run.

import type { BoardPhase, BoardRow } from '../../../shared/board'
import { spriteForPreset, type AgentSpriteKind } from '../nodes/AgentSprite'

export interface WorldAgent {
  id: string
  name: string
  harness: AgentSpriteKind
  orch: boolean
  phase: BoardPhase
  /** Sous title if there is one, else the prompt's first line. */
  title: string
  turnCount: number
  lastActivityAt: number
  /** Where the tower stands on its island, in island-local units. */
  at: { x: number; z: number }
}

export interface WorldPlace {
  id: string
  name: string
  icon: string
  /** The workspace currently loaded: the only one with full card detail. */
  active: boolean
  agents: WorldAgent[]
  waiting: number
  working: number
  lastActivityAt: number
  /** Island radius, from the size of the crew. */
  radius: number
  /** Where the island floats. −z recedes from the viewer. */
  at: { x: number; y: number; z: number }
}

export interface WorkspaceLike {
  id: string
  name: string
  icon?: string
}

/** Deterministic 0..1 from an id, so an island never jitters between renders. */
function hashUnit(text: string): number {
  let h = 2166136261
  for (const ch of text) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

const MINUTE = 60_000
/** The avenue's spacing: a constant stride plus the dormancy between places. */
const STRIDE = 210
const AGE_PULL = 130
const LANE = 150
/**
 * How much wider each lane gets as it recedes. Perspective shrinks a constant
 * lane toward the vanishing point, so without this the dormant end of the
 * avenue collapses into one pile of overlapping islands — which is what the
 * first render did.
 */
const LANE_FAN = 120

/**
 * How far behind the previous island this one sits. Log of the age GAP, not of
 * the age itself, so a fleet all touched this morning is a tight cluster and a
 * workspace nobody has opened in a week is genuinely out in the fog — rather
 * than everything spreading out just because the clock moved.
 */
export function strideFor(gapMs: number): number {
  return STRIDE + AGE_PULL * Math.log1p(Math.max(0, gapMs) / (30 * MINUTE))
}

const RANK: Record<BoardPhase, number> = {
  waiting: 0,
  working: 1,
  unread: 2,
  done: 3,
  offline: 4
}

/**
 * Lay the crew out on their island: a tidy spiral from the middle, so the
 * agents that want something are nearest the island's centre and a glance at
 * the middle of an island is a glance at its urgent work.
 */
function seatCrew(agents: WorldAgent[]): WorldAgent[] {
  const order = [...agents].sort(
    (a, b) => RANK[a.phase] - RANK[b.phase] || b.lastActivityAt - a.lastActivityAt
  )
  const golden = Math.PI * (3 - Math.sqrt(5))
  return order.map((agent, i) => {
    // Sunflower packing: even density, no ring artefacts, and stable for a
    // given crew size — the same agent keeps the same spot between frames.
    const r = Math.sqrt((i + 0.5) / order.length)
    const theta = i * golden
    return { ...agent, at: { x: Math.cos(theta) * r, z: Math.sin(theta) * r } }
  })
}

/** Island radius from crew size: area per agent is constant, so it reads true. */
export function radiusFor(crew: number): number {
  return 26 + Math.sqrt(Math.max(1, crew)) * 13
}

/**
 * Board rows (every workspace, not just the loaded one) and the workspace list
 * become the world. A workspace with no rows in the board's window still gets
 * an island — an empty place out in the fog is information, and dropping it
 * would make the map lie about what you have.
 */
export function readFleet(
  rows: readonly BoardRow[],
  workspaces: readonly WorkspaceLike[],
  activeId: string,
  now: number
): WorldPlace[] {
  const byPlace = new Map<string, WorldAgent[]>()
  const names = new Map<string, string>()
  for (const row of rows) {
    const id = row.workspace.id
    names.set(id, row.workspace.name)
    const agent: WorldAgent = {
      id: row.terminalId,
      name: row.agent.name,
      harness: spriteForPreset(row.agent.preset),
      orch: row.agent.orch,
      phase: row.phase,
      title: (row.task.title ?? row.task.summary ?? '').trim(),
      turnCount: row.turnCount,
      lastActivityAt: row.lastActivityAt,
      at: { x: 0, z: 0 }
    }
    const list = byPlace.get(id)
    if (list) list.push(agent)
    else byPlace.set(id, [agent])
  }

  const known = new Map(workspaces.map((w) => [w.id, w]))
  const ids = new Set<string>([...known.keys(), ...byPlace.keys()])
  const places = [...ids].map((id) => {
    const crew = seatCrew(byPlace.get(id) ?? [])
    const meta = known.get(id)
    return {
      id,
      name: meta?.name ?? names.get(id) ?? id.slice(0, 8),
      icon: meta?.icon ?? '🗂',
      active: id === activeId,
      agents: crew,
      waiting: crew.filter((a) => a.phase === 'waiting').length,
      working: crew.filter((a) => a.phase === 'working').length,
      lastActivityAt: crew.reduce((t, a) => Math.max(t, a.lastActivityAt), 0),
      radius: radiusFor(crew.length),
      at: { x: 0, y: 0, z: 0 }
    }
  })

  // The avenue. Freshest at the viewer's feet, then receding by how long each
  // has been left alone. The ACTIVE workspace leads whatever its clock says:
  // it is the one you are standing in, and a map that put it behind you would
  // be describing somewhere else.
  places.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return b.lastActivityAt - a.lastActivityAt
  })

  let z = 0
  return places.map((place, i) => {
    if (i > 0) {
      const ahead = places[i - 1]
      const gap = ahead.lastActivityAt > 0 && place.lastActivityAt > 0
        ? ahead.lastActivityAt - place.lastActivityAt
        : 6 * 60 * MINUTE
      z -= strideFor(gap)
    }
    const side = i % 2 === 0 ? -1 : 1
    const drift = (hashUnit(place.id) - 0.5) * 50
    return {
      ...place,
      at: {
        x: i === 0 ? drift * 0.4 : side * (LANE + Math.floor(i / 2) * LANE_FAN) + drift,
        // A little height, so the avenue is a field rather than a railway.
        y: (hashUnit(`${place.id}y`) - 0.5) * 26,
        z
      }
    }
  })
}

/** Total crew and how many of them want a person — the HUD's two numbers. */
export function fleetTotals(places: readonly WorldPlace[]): {
  agents: number
  waiting: number
  working: number
  places: number
} {
  return {
    agents: places.reduce((n, p) => n + p.agents.length, 0),
    waiting: places.reduce((n, p) => n + p.waiting, 0),
    working: places.reduce((n, p) => n + p.working, 0),
    places: places.length
  }
}

/** Tower height from turns: log, so a 300-turn agent does not leave the sky. */
export function towerHeight(turnCount: number): number {
  return 6 + Math.log1p(Math.max(0, turnCount)) * 9
}

export const PHASE_COLOUR: Record<BoardPhase, number> = {
  working: 0xff9f0a,
  waiting: 0xff453a,
  unread: 0x64d2ff,
  done: 0x32d74b,
  offline: 0x6b665b
}

export const PHASE_WORD: Record<BoardPhase, string> = {
  working: '在干活',
  waiting: '在等你',
  unread: '回复未读',
  done: '完成',
  offline: '离线'
}
