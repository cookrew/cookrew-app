// THE LEVEL MODEL: everything a level draws and every rect it draws it at,
// from (path, fleet, viewport, kit) alone. Scenes render it; the shell reads
// its items for the keyboard and its agent rects for the summary card. Pure.
import type { LevelsAgent, LevelsWorkspace, Rect, StrataMachine, StrataPath } from '../../shared/strata'
import { levelOf } from '../../shared/strata'
import type { FigureKit } from '../seams'
import { agentKey } from '../finder/search'
import { inset, mapRect, type Transform } from './geometry'
import {
  layoutAgents,
  layoutMachines,
  layoutTerminal,
  layoutWorkspaces,
  columnsFor,
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
  /** The drawn seat. */
  rect: Rect
  /** The hit target: the seat grown to its full pitch (the gap between seats is shared). */
  hit: Rect
  agent: LevelsAgent
}

/** Seat pitch from the first two seats of a row; seats are drawn at 80% of it by convention when alone. */
const pitchOf = (seats: readonly Rect[]): number =>
  seats.length >= 2 && Math.abs(seats[1].y - seats[0].y) < 0.5 ? seats[1].x - seats[0].x : (seats[0]?.w ?? 0) * 1.25

const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by })

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
    const margin = Math.max(0, (pitchOf(seats) - (seats[0]?.w ?? 0)) / 2)
    return seats.map((rect, s) => {
      const agent = workspaces[i].agents[s]
      return {
        key: agentKey(machine.id, agent.id),
        path: { machine: machine.id, workspace: workspaces[i].id, agent: agent.id },
        rect,
        hit: grow(rect, margin),
        agent
      }
    })
  })

const workspaceInputs = (workspaces: readonly LevelsWorkspace[]) => workspaces.map((w) => ({ id: w.id, name: w.name, agents: w.agents.length }))

export const machineWorkspaces = (machine: StrataMachine | null | undefined): LevelsWorkspace[] => machine?.levels?.workspaces ?? []

export const buildLevelModel = (path: StrataPath, fleet: readonly StrataMachine[], viewport: Rect, kit: FigureKit): LevelModel => {
  const area = levelArea(viewport)
  const columns = columnsFor(viewport)
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
      const levelCells = layoutWorkspaces(workspaceInputs(workspaces), area, kit, { columns })
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
    const cells = machine ? layoutWorkspaces(workspaceInputs(workspaces), area, kit, { columns }) : []
    return {
      level,
      machine,
      cells,
      items: cells.map((c) => ({ target: { machine: machine?.id, workspace: c.id }, rect: c.rect })),
      seats: machine ? seatsOf(machine, workspaces, cells) : []
    }
  }

  if (level === 'agents') {
    const cell = machine && workspace ? layoutAgents({ id: workspace.id, name: workspace.name, agents: workspace.agents.length }, area, kit, columns) : null
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
