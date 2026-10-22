// THE SAMPLE FLEET'S MANIFEST, as the registry reads it: where the front
// page's six pictures are in the strata shell's bundle, how big each is, and
// where every machine tag, table tag and seat sits on it. The pictures and
// this manifest are drawn at the shell's build (site-art.ts); the registry
// only reads them, so the figure kit never enters the registry's bundle.
//
// The manifest travels in a ConfigMap like everything else in that bundle;
// it is checked here as data from outside, and the page escapes every name.
import type { AgentPhase, Harness, Rect } from '../../src/shared/strata'
import type { ShellBundle } from './strata-shell'

/** Where the pictures sit in the shell's bundle: under assets/, so they are served immutable. */
export const ART_DIR = 'assets/art/'
/** The manifest's path in the shell's bundle. */
export const ART_MANIFEST = 'site-art.json'

export interface MachineTag {
  name: string
  sub: string
  line: string
  waiting: number
  /** The figure and its label box, in picture units. */
  fig: Rect
  label: Rect
}
export interface TableTag {
  name: string
  agents: number
  waiting: number
  fig: Rect
  label: Rect
}
export interface SeatTag {
  name: string
  harness: Harness
  phase: AgentPhase
  rect: Rect
}

interface Picture {
  /** Path in the shell's bundle (ART_DIR…), content-addressed. */
  file: string
  w: number
  h: number
}
export type MachinesPicture = Picture & { tags: MachineTag[] }
export type TablesPicture = Picture & { tags: TableTag[] }
export type SeatsPicture = Picture & { seats: SeatTag[] }

export interface SampleArt {
  /** The machine and the table the sample steps into (the first of each). */
  machine: string
  table: string
  machines: { desk: MachinesPicture; phone: MachinesPicture }
  tables: { desk: TablesPicture; phone: TablesPicture }
  seats: { desk: SeatsPicture; phone: SeatsPicture }
}

const PHASES: ReadonlySet<string> = new Set(['idle', 'thinking', 'waiting', 'replied', 'offline'])
const HARNESSES: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode', 'pi', 'shell', 'other'])
const MAX_ITEMS = 48

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 80
const rect = (v: unknown): v is Rect => isObj(v) && num(v.x) && num(v.y) && num(v.w) && num(v.h) && v.w >= 0 && v.h >= 0
const count = (v: unknown): v is number => num(v) && Number.isInteger(v) && v >= 0 && v <= 999

const list = <T>(v: unknown, item: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.length > 0 && v.length <= MAX_ITEMS && v.every(item)
const machineTag = (v: unknown): v is MachineTag => isObj(v) && text(v.name) && text(v.sub) && text(v.line) && count(v.waiting) && rect(v.fig) && rect(v.label)
const tableTag = (v: unknown): v is TableTag => isObj(v) && text(v.name) && count(v.agents) && count(v.waiting) && rect(v.fig) && rect(v.label)
const seatTag = (v: unknown): v is SeatTag =>
  isObj(v) && text(v.name) && typeof v.harness === 'string' && HARNESSES.has(v.harness) && typeof v.phase === 'string' && PHASES.has(v.phase) && rect(v.rect)

/** A picture whose file is one of the bundle's own, under ART_DIR. */
const picture = (v: unknown, files: ShellBundle['files']): v is Picture =>
  isObj(v) &&
  typeof v.file === 'string' &&
  v.file.startsWith(ART_DIR) &&
  Object.prototype.hasOwnProperty.call(files, v.file) &&
  num(v.w) &&
  num(v.h) &&
  v.w > 0 &&
  v.h > 0

const pair = <T>(v: unknown, files: ShellBundle['files'], rest: (p: Obj) => boolean): v is { desk: T; phone: T } =>
  isObj(v) && [v.desk, v.phone].every((p) => picture(p, files) && rest(p as unknown as Obj))

/** The sample's manifest from the shell's bundle, or null when the bundle has none (or a malformed one). */
export function readSampleArt(bundle: ShellBundle | null | undefined): SampleArt | null {
  const file = bundle?.files[ART_MANIFEST]
  if (!bundle || !file || !Object.prototype.hasOwnProperty.call(bundle.files, ART_MANIFEST)) return null
  try {
    const raw: unknown = JSON.parse(file.encoding === 'base64' ? Buffer.from(file.body, 'base64').toString('utf8') : file.body)
    if (!isObj(raw) || !text(raw.machine) || !text(raw.table)) return null
    const ok =
      pair(raw.machines, bundle.files, (p) => list(p.tags, machineTag)) &&
      pair(raw.tables, bundle.files, (p) => list(p.tags, tableTag)) &&
      pair(raw.seats, bundle.files, (p) => list(p.seats, seatTag))
    return ok ? (raw as unknown as SampleArt) : null
  } catch {
    return null
  }
}
