// THE LEVEL MODEL: everything a level draws and every rect it draws it at,
// from (path, fleet, viewport, kit) alone. Scenes render it; the shell reads
// its items for the keyboard and its agent rects for the summary card. Pure.
import type { LevelsAgent, LevelsWorkspace, Rect, StrataMachine, StrataPath } from '../../shared/strata'
import { BALL } from '../figures'
import { levelOf } from '../../shared/strata'
import type { FigureKit } from '../seams'
import { agentKey } from '../finder/search'
import { inset, mapRect, type Transform } from './geometry'
import {
  layoutAgents,
  layoutMachines,
  layoutTerminal,
  layoutWorkspaces,
  miniatureTransform,
  type ContainerCell,
  type MachineCell,
  type TerminalLayout
} from './layout'
import type { LevelItem } from './selection'

/**
 * Every level lays out inside the same inset of the stage, so miniatures match
 * exactly. The top bar floats over the stage host, so every level keeps a top
 * inset for it and no flight ever sees the host resize.
 */
export const TOP_BAR = 52
export const levelArea = (viewport: Rect): Rect => inset(viewport, TOP_BAR + 16, 20, 16, 20)

export interface SeatRef {
  key: string
  path: Required<StrataPath>
  /** The drawn seat: the avatar's whole art (ball, shadow and air, see BALL). */
  rect: Rect
  /** The drawn ball, which is all of the seat that belongs to this agent alone. */
  ball: Rect
  /** The hit target: a square on the ball as wide as the pitch, so no two seats' hits ever overlap. */
  hit: Rect
  agent: LevelsAgent
}

/**
 * The widest square around each seat that never reaches a neighbour's: the
 * nearest neighbour by the larger of |dx| and |dy|. The table's seats sit on
 * screen diagonals, so the next seat in a row is not on the same screen row.
 */
const pitchOf = (seats: readonly Rect[]): number => {
  if (seats.length < 2) return (seats[0]?.w ?? 0) * BALL.d * 1.25
  let nearest = Infinity
  for (let i = 0; i < seats.length; i++)
    for (let j = i + 1; j < seats.length; j++) nearest = Math.min(nearest, Math.max(Math.abs(seats[j].x - seats[i].x), Math.abs(seats[j].y - seats[i].y)))
  return nearest
}

const onBall = (seat: Rect, side: number): Rect => ({
  x: seat.x + BALL.cx * seat.w - side / 2,
  y: seat.y + BALL.cy * seat.w - side / 2,
  w: side,
  h: side
})

export interface Miniature {
  transform: Transform
  cells: ContainerCell[]
  seats: SeatRef[]
}

export type LevelModel =
  | { level: 'machines'; cells: MachineCell[]; minis: ReadonlyMap<string, Miniature>; items: LevelItem[]; seats: SeatRef[] }
  | { level: 'workspaces'; machine: StrataMachine | null; cells: ContainerCell[]; items: LevelItem[]; seats: SeatRef[] }
  | { level: 'agents'; machine: StrataMachine | null; workspace: LevelsWorkspace | null; cell: ContainerCell | null; items: LevelItem[]; seats: SeatRef[] }
  | { level: 'terminal'; machine: StrataMachine | null; workspace: LevelsWorkspace | null; agent: LevelsAgent | null; layout: TerminalLayout; items: LevelItem[]; seats: SeatRef[] }

const seatsOf = (machine: StrataMachine, workspaces: readonly LevelsWorkspace[], cells: readonly ContainerCell[], t?: Transform): SeatRef[] =>
  cells.flatMap((cell, i) => {
    const seats = t ? cell.seats.map((r) => mapRect(r, t)) : cell.seats
    const pitch = pitchOf(seats)
    return seats.map((rect, s) => {
      const agent = workspaces[i].agents[s]
      return {
        key: agentKey(machine.id, agent.id),
        path: { machine: machine.id, workspace: workspaces[i].id, agent: agent.id },
        rect,
        ball: onBall(rect, BALL.d * rect.w),
        hit: onBall(rect, Math.max(BALL.d * rect.w, pitch)),
        agent
      }
    })
  })

const workspaceInput = (w: LevelsWorkspace) => ({ id: w.id, name: w.name, agents: w.agents.length, ...(w.traits?.length && { traits: w.traits }) })
const workspaceInputs = (workspaces: readonly LevelsWorkspace[]) => workspaces.map(workspaceInput)

export const machineWorkspaces = (machine: StrataMachine | null | undefined): LevelsWorkspace[] => machine?.levels?.workspaces ?? []

export const buildLevelModel = (path: StrataPath, fleet: readonly StrataMachine[], viewport: Rect, kit: FigureKit): LevelModel => {
  const area = levelArea(viewport)
  const level = levelOf(path)
  const machine = fleet.find((m) => m.id === path.machine) ?? null
  const workspace = machineWorkspaces(machine).find((w) => w.id === path.workspace) ?? null

  if (level === 'machines') {
    const cells = layoutMachines(
      fleet.map((m) => ({ id: m.id, kind: m.profile?.kind ?? 'unknown', link: m.link, reached: m.lastSeenAt !== null || m.levels !== null })),
      area,
      kit
    )
    const minis = new Map<string, Miniature>()
    cells.forEach((cell, i) => {
      const m = fleet[i]
      const workspaces = machineWorkspaces(m)
      if (workspaces.length === 0) return
      const levelCells = layoutWorkspaces(workspaceInputs(workspaces), area, kit)
      const transform = miniatureTransform(area, cell.portal)
      minis.set(m.id, {
        transform,
        cells: levelCells.map((c) => ({ ...c, rect: mapRect(c.rect, transform), seats: c.seats.map((s) => mapRect(s, transform)) })),
        seats: seatsOf(m, workspaces, levelCells, transform)
      })
    })
    return {
      level,
      cells,
      minis,
      items: cells.map((c) => ({ target: { machine: c.id }, rect: c.rect })),
      seats: [...minis.values()].flatMap((mini) => mini.seats)
    }
  }

  if (level === 'workspaces') {
    const workspaces = machineWorkspaces(machine)
    const cells = machine ? layoutWorkspaces(workspaceInputs(workspaces), area, kit) : []
    return {
      level,
      machine,
      cells,
      items: cells.map((c) => ({ target: { machine: machine?.id, workspace: c.id }, rect: c.rect })),
      seats: machine ? seatsOf(machine, workspaces, cells) : []
    }
  }

  if (level === 'agents') {
    const cell = machine && workspace ? layoutAgents(workspaceInput(workspace), area, kit) : null
    const seats = machine && workspace && cell ? seatsOf(machine, [workspace], [cell]) : []
    return { level, machine, workspace, cell, seats, items: seats.map((s) => ({ target: s.path, rect: s.rect })) }
  }

  const agent = workspace?.agents.find((a) => a.id === path.agent) ?? null
  return { level, machine, workspace, agent, layout: layoutTerminal(viewport, TOP_BAR), items: [], seats: [] }
}

export const isWaiting = (machine: StrataMachine | null | undefined, target: StrataPath): boolean => {
  if (!machine || machine.link !== 'live') return false
  return machineWorkspaces(machine).some(
    (w) => (!target.workspace || w.id === target.workspace) && w.agents.some((a) => a.phase === 'waiting' && (!target.agent || a.id === target.agent))
  )
}
