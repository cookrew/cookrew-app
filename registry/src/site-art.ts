// THE SAMPLE FLEET'S PICTURES — the homepage's three levels, drawn by the
// same figure kit and level layouts that draw a signed-in reader's own fleet
// at /me, so the shape a visitor learns here is the shape they get.
//
// Each level is ONE svg (avatars deduplicated as <symbol>/<use>), drawn when
// the strata shell is built (scripts/strata-build.mjs) and shipped in the
// shell's bundle under assets/art/, content-addressed, beside a manifest of
// where every tag and seat sits (site-art-manifest.ts reads it). The kit
// itself never enters the registry's bundle: NOTHING the server imports may
// import this file. The front page is a document with no script, so the stage
// over these pictures is radios, labels and HTML tags placed in percent.
//
// Everything here is a SAMPLE and says so on the page: invented machine,
// workspace and agent names, a fixed pattern of phases, no session text.
import { createHash } from 'node:crypto'
import type { AgentPhase, Harness, MachineKind, MachineLink, Rect } from '../../src/shared/strata'
import { colorFigures, DARK_SHADOW, DARK_SILHOUETTE } from '../../src/strata/figures'
import { mapRect } from '../../src/strata/levels/geometry'
import { layoutAgents, layoutMachines, layoutWorkspaces, miniatureTransform } from '../../src/strata/levels/layout'
import { ART_DIR, ART_MANIFEST, type MachineTag, type MachinesPicture, type SampleArt, type SeatTag, type SeatsPicture, type TableTag, type TablesPicture } from './site-art-manifest'

export const SAMPLE_PHASES: readonly AgentPhase[] = ['thinking', 'idle', 'replied', 'idle', 'thinking', 'waiting', 'idle', 'replied', 'idle', 'thinking', 'idle', 'idle']
const HARNESSES: readonly Harness[] = ['claude', 'codex', 'claude', 'opencode', 'pi', 'claude', 'codex', 'shell', 'claude', 'pi', 'codex', 'claude']
const AGENT_NAMES = ['Ada', 'Basil', 'Cleo', 'Dune', 'Echo', 'Fern', 'Gus', 'Hazel', 'Iris', 'Juno', 'Kip', 'Lumen']

interface SampleMachine {
  id: string
  kind: MachineKind
  model: string | null
  label: string
  link: MachineLink
  workspaces: ReadonlyArray<readonly [name: string, agents: number]>
}

/** The sample: one live desktop with three workspaces, a cloud box, a laptop that has been away. */
export const SAMPLE_FLEET: readonly SampleMachine[] = [
  { id: 'studio', kind: 'desktop', model: 'Mac mini (2023)', label: 'Mac mini', link: 'live', workspaces: [['Monorepo', 12], ['Paper Notes', 5], ['Home Lab', 2]] },
  { id: 'night-runner', kind: 'cloud', model: null, label: 'Cloud VM', link: 'live', workspaces: [['CI Night Shift', 6], ['Data Pipes', 3]] },
  { id: 'old-thinkpad', kind: 'laptop', model: null, label: 'Laptop', link: 'offline', workspaces: [['Thesis', 3]] }
]

/** The machine and workspace the sample steps into. */
export const SAMPLE_PATH = { machine: SAMPLE_FLEET[0], workspace: SAMPLE_FLEET[0].workspaces[0] } as const

/** Phase of seat `seat` in the `table`-th workspace of a machine: one fixed pattern, offset per table. */
export const samplePhase = (seat: number, table = 0): AgentPhase => SAMPLE_PHASES[(seat + table * 3) % SAMPLE_PHASES.length]

interface Drawn {
  file: string
  svg: string
  w: number
  h: number
}

/** Picture sizes, in layout units: wide for a desktop column, tall for a phone. */
const SIZES = { desk: { machines: [1080, 400], tables: [1080, 380], seats: [1080, 400] }, phone: { machines: [340, 520], tables: [340, 560], seats: [340, 420] } } as const

const r1 = (v: number) => Math.round(v * 10) / 10
/** Silhouettes lift and shadows deepen on a dark page; an <img> carries its own rule. */
const DARK_STYLE = `<style>@media (prefers-color-scheme:dark){.cf{color:${DARK_SILHOUETTE};--cf-shadow:${DARK_SHADOW}}}</style>`

/** One picture under construction: nested figures plus avatar symbols used by reference. */
class Composer {
  private readonly parts: string[] = []
  private readonly symbols = new Map<string, string>()

  nest(svg: string, r: Rect): void {
    this.parts.push(svg.replace('<svg xmlns="http://www.w3.org/2000/svg"', `<svg x="${r1(r.x)}" y="${r1(r.y)}" width="${r1(r.w)}" height="${r1(r.h)}"`))
  }

  avatar(phase: AgentPhase, harness: Harness, size: 'dot' | 'small' | 'full', r: Rect, dim: boolean): void {
    const id = `a-${phase}-${harness}-${size}`
    if (!this.symbols.has(id)) {
      const art = colorFigures.avatar({ phase, source: 'live', harness, size })
      const open = art.svg.indexOf('>')
      const attrs = art.svg.slice(4, open).replace(/xmlns="[^"]*"/, '').replace(/viewBox="[^"]*"/, '')
      const vb = art.viewBox
      this.symbols.set(id, `<symbol id="${id}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}"><g ${attrs}>${art.svg.slice(open + 1, -'</svg>'.length)}</g></symbol>`)
    }
    this.parts.push(`<use href="#${id}" x="${r1(r.x)}" y="${r1(r.y)}" width="${r1(r.w)}" height="${r1(r.h)}"${dim ? ' opacity=".45"' : ''}/>`)
  }

  finish(name: string, label: string, view: Rect): Drawn {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(view.x)} ${r1(view.y)} ${r1(view.w)} ${r1(view.h)}" role="img" aria-label="${label}">` +
      `${DARK_STYLE}<defs>${[...this.symbols.values()].join('')}</defs>${this.parts.join('')}</svg>`
    const hash = createHash('sha256').update(svg).digest('hex').slice(0, 12)
    return { file: `${ART_DIR}${name}.${hash}.svg`, svg, w: r1(view.w), h: r1(view.h) }
  }
}

const tablesOf = (m: SampleMachine) => m.workspaces.map(([name, agents], k) => ({ id: `${m.id}-${k}`, name, agents }))
const waitingAt = (agents: number, table: number) => Array.from({ length: agents }, (_, j) => samplePhase(j, table)).filter((p) => p === 'waiting').length

/** L0: every machine, with its workspaces as a miniature on the figure. */
function machinesPicture(name: string, w: number, h: number): MachinesPicture & Drawn {
  const area = { x: 0, y: 0, w, h }
  const cells = layoutMachines(SAMPLE_FLEET.map((m) => ({ id: m.id, kind: m.kind, link: m.link, reached: true })), area, colorFigures)
  const art = new Composer()
  const tags = cells.map((cell, i): MachineTag => {
    const m = SAMPLE_FLEET[i]
    const live = m.link === 'live'
    art.nest(colorFigures.machine({ kind: m.kind, link: m.link, model: m.model }).svg, cell.rect)
    const into = miniatureTransform(area, cell.portal)
    layoutWorkspaces(tablesOf(m), area, colorFigures).forEach((table, k) => {
      art.nest(table.art.svg, mapRect(table.rect, into))
      table.seats.forEach((seat, j) => art.avatar(live ? samplePhase(j, k) : 'offline', HARNESSES[(j + k * 3) % HARNESSES.length], 'dot', mapRect(seat, into), !live))
    })
    const agents = m.workspaces.reduce((sum, [, a]) => sum + a, 0)
    return {
      name: m.id,
      sub: `${m.label} · ${live ? 'live' : 'offline 3 days'}`,
      line: `${m.workspaces.length} workspace${m.workspaces.length === 1 ? '' : 's'} · ${agents} agents`,
      waiting: live ? m.workspaces.reduce((sum, [, a], k) => sum + waitingAt(a, k), 0) : 0,
      fig: cell.rect,
      label: cell.label
    }
  })
  return { ...art.finish(name, 'Sample fleet: three machines', area), tags }
}

/** L1: the first machine's workspaces, one table each, a seat per agent. */
function tablesPicture(name: string, w: number, h: number): TablesPicture & Drawn {
  const area = { x: 0, y: 0, w, h }
  const m = SAMPLE_PATH.machine
  const art = new Composer()
  const tags = layoutWorkspaces(tablesOf(m), area, colorFigures).map((cell, k): TableTag => {
    art.nest(cell.art.svg, cell.rect)
    cell.seats.forEach((seat, j) => art.avatar(samplePhase(j, k), HARNESSES[(j + k * 3) % HARNESSES.length], 'small', seat, false))
    const [table, agents] = m.workspaces[k]
    return { name: table, agents, waiting: waitingAt(agents, k), fig: cell.rect, label: { x: cell.rect.x, y: cell.rect.y + cell.rect.h + 6, w: cell.rect.w, h: 40 } }
  })
  return { ...art.finish(name, `Sample machine ${m.id}: ${m.workspaces.length} workspace tables`, area), tags }
}

/** L2: one table, every agent at its seat; cropped to the table so a short one still fills its frame. */
function seatsPicture(name: string, w: number, h: number): SeatsPicture & Drawn {
  const area = { x: 0, y: 0, w, h }
  const [table, count] = SAMPLE_PATH.workspace
  const cell = layoutAgents({ id: 'sample', name: table, agents: count }, area, colorFigures)
  if (cell === null) throw new Error(`the sample table ${table} has no layout`)
  const art = new Composer()
  art.nest(cell.art.svg, cell.rect)
  const t = cell.rect
  // Room above the table for a pin, a little either side for the shadow.
  const view = { x: t.x - t.w * 0.04, y: t.y - t.h * 0.14, w: t.w * 1.08, h: t.h * 1.2 }
  const seats = cell.seats.map((rect, i): SeatTag => {
    const seat = { name: AGENT_NAMES[i % AGENT_NAMES.length], harness: HARNESSES[i % HARNESSES.length], phase: samplePhase(i) }
    art.avatar(seat.phase, seat.harness, 'full', rect, false)
    return { ...seat, rect: { x: rect.x - view.x, y: rect.y - view.y, w: rect.w, h: rect.h } }
  })
  return { ...art.finish(name, `Sample workspace ${table}: ${count} agents at one table`, view), seats }
}

export interface ComposedArt {
  /** Path under the shell's prefix → the svg. */
  files: Readonly<Record<string, string>>
  /** What the front page reads: every picture's path and size, and where its tags and seats sit. */
  manifest: SampleArt
}

const strip = <T extends Drawn>({ svg: _svg, ...rest }: T): Omit<T, 'svg'> => rest

/** The six pictures (three levels × desktop and phone) and their manifest. */
export function composeSampleArt(): ComposedArt {
  const { desk, phone } = SIZES
  const machines = { desk: machinesPicture('machines-desk', desk.machines[0], desk.machines[1]), phone: machinesPicture('machines-phone', phone.machines[0], phone.machines[1]) }
  const tables = { desk: tablesPicture('tables-desk', desk.tables[0], desk.tables[1]), phone: tablesPicture('tables-phone', phone.tables[0], phone.tables[1]) }
  const seats = { desk: seatsPicture('seats-desk', desk.seats[0], desk.seats[1]), phone: seatsPicture('seats-phone', phone.seats[0], phone.seats[1]) }
  const all: Drawn[] = [machines.desk, machines.phone, tables.desk, tables.phone, seats.desk, seats.phone]
  return {
    files: Object.fromEntries(all.map((p) => [p.file, p.svg])),
    manifest: {
      machine: SAMPLE_PATH.machine.id,
      table: SAMPLE_PATH.workspace[0],
      machines: { desk: strip(machines.desk), phone: strip(machines.phone) },
      tables: { desk: strip(tables.desk), phone: strip(tables.phone) },
      seats: { desk: strip(seats.desk), phone: strip(seats.phone) }
    }
  }
}

/** The manifest's own path, beside the pictures. */
export { ART_MANIFEST }
