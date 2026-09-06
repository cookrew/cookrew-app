import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileSlug } from '../shared/slug'
import { planStorageGc, type GcCandidate, type GcPlan } from './storage-gc'

/**
 * The disk half of the storage sweep: read the stores, build the three
 * reference sets, hand everything to the pure planner, and — only when asked —
 * unlink.
 *
 * The reference sets are collected by SCANNING rather than from an index,
 * because no index exists: nothing ever recorded which attachment a turn cited.
 * A scan can only err toward "referenced" if it reads too much, which is the
 * safe direction, so it reads every store that could name one.
 */

const DAY = 24 * 60 * 60 * 1000
/** Conservative on purpose — see the grace-period reasoning in storage-gc.ts. */
export const DEFAULT_GRACE_MS = 30 * DAY

/** `teams/<slug>-sessions/` holds the session files a saved team snapshotted. */
const SIDECAR_SUFFIX = '-sessions'

export interface StorageRoots {
  turns: string
  attachments: string
  workspaces: string
  teams: string
  annotations: string
}

export function defaultStorageRoots(base = path.join(homedir(), '.cookrew')): StorageRoots {
  return {
    turns: path.join(base, 'turns'),
    attachments: path.join(base, 'attachments'),
    workspaces: path.join(base, 'workspaces'),
    teams: path.join(base, 'teams'),
    annotations: path.join(base, 'checkpoint-annotations')
  }
}

/** Every file under `dir`, recursively. Missing directories answer empty. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Node ids named by any workspace canvas or any saved team. */
export function collectLiveTerminalIds(roots: StorageRoots): Set<string> {
  const ids = new Set<string>()
  const harvest = (text: string): void => {
    try {
      const parsed = JSON.parse(text) as { nodes?: { id?: string }[] }
      for (const node of parsed.nodes ?? []) if (node.id) ids.add(node.id)
    } catch {
      // A half-written or legacy file contributes nothing rather than throwing.
      // It also contributes no DELETIONS: an unreadable canvas can only make
      // the live set smaller, so the grace period is what stops that from
      // mattering, and a store that cannot be read at all is handled by the
      // caller's abort below.
    }
  }
  for (const file of walk(roots.workspaces)) {
    if (path.basename(file) === 'workspace.json') harvest(safeRead(file))
  }
  for (const file of walk(roots.teams)) {
    if (file.endsWith('.json')) harvest(safeRead(file))
  }
  return ids
}

/** Attachment file names cited anywhere a citation could survive. */
export function collectReferencedAttachments(
  roots: StorageRoots,
  names: readonly string[]
): Set<string> {
  const referenced = new Set<string>()
  const pending = new Set(names)
  const searched = [roots.workspaces, roots.teams, roots.turns, roots.annotations]
  for (const dir of searched) {
    for (const file of walk(dir)) {
      if (pending.size === 0) return referenced
      const text = safeRead(file)
      if (text.length === 0) continue
      for (const name of [...pending]) {
        if (text.includes(name)) {
          referenced.add(name)
          pending.delete(name)
        }
      }
    }
  }
  return referenced
}

/** The sidecar key a team resolves for one of its sessions-map values. */
const sidecarKey = (teamName: string, fileName: string): string =>
  path.join(`${fileSlug(teamName)}${SIDECAR_SUFFIX}`, fileName)

/**
 * The sidecar keys one team JSON resolves, or null when the file cannot be
 * READ: an unreadable or half-written file might name anything. A file that
 * parses but is not a team (no string name) is one `TeamStore.read` rejects
 * too, so it resolves nothing — that is the same answer the app gives, and
 * a stray manifest in teams/ must not switch the class off forever.
 */
function sidecarKeysOfTeam(text: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const team = parsed as { name?: unknown; sessions?: unknown }
  if (typeof team.name !== 'string') return []
  const sessions = team.sessions
  if (typeof sessions !== 'object' || sessions === null) return []
  return Object.values(sessions as Record<string, unknown>)
    .filter((value): value is string => typeof value === 'string')
    .map((fileName) => sidecarKey(team.name as string, fileName))
}

/**
 * Sidecar keys some saved team can still read — `TeamStore.sessionLines`
 * resolves `<fileSlug(team.name)>-sessions/<sessions[id]>`, and nothing else
 * ever opens a sidecar, so that relative path is what "referenced" means.
 *
 * Answers NULL when any team JSON is unreadable. The live set can only shrink
 * through a file we failed to read, and for sidecars a shrunken live set is a
 * deletion: an unreadable team is indistinguishable from one that names every
 * file. The caller turns null into an empty candidate list.
 *
 * Reads everything `TeamStore.list` would: every `*.json` that is not a
 * directory, symlinks included — readdir does not follow a link, readFile
 * does, and skipping a linked team would plan its live sidecars.
 */
export function collectReferencedSidecars(roots: StorageRoots): Set<string> | null {
  const referenced = new Set<string>()
  if (!existsSync(roots.teams)) return referenced
  for (const entry of readdirSync(roots.teams, { withFileTypes: true })) {
    if (entry.isDirectory() || !entry.name.endsWith('.json')) continue
    const keys = sidecarKeysOfTeam(safeRead(path.join(roots.teams, entry.name)))
    if (keys === null) return null
    for (const key of keys) referenced.add(key)
  }
  return referenced
}

function candidatesIn(dir: string, keyOf: (file: string) => string): GcCandidate[] {
  const out: GcCandidate[] = []
  for (const file of walk(dir)) {
    try {
      const stat = statSync(file)
      out.push({ key: keyOf(file), path: file, bytes: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // Gone between walk and stat — a team save pruned its own sidecar while
      // we were looking. Not a candidate, and not a reason to lose the sweep.
    }
  }
  return out
}

/** A ledger file is `<terminalId>.jsonl`; `.migrated` siblings share the id. */
const terminalIdOf = (file: string): string => path.basename(file).split('.')[0]

/** Every file under every `teams/<slug>-sessions/`, keyed relative to teams. */
export function sidecarCandidates(roots: StorageRoots): GcCandidate[] {
  if (!existsSync(roots.teams)) return []
  return readdirSync(roots.teams, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(SIDECAR_SUFFIX))
    .flatMap((entry) =>
      candidatesIn(path.join(roots.teams, entry.name), (file) => path.relative(roots.teams, file))
    )
}

export interface SweepOptions {
  roots?: StorageRoots
  now?: number
  graceMs?: number
  /** False plans without unlinking — the dry run is the same code path. */
  apply?: boolean
}

/** A candidate class the sweep knows how to plan. */
export type SweepClass = 'ledgers' | 'attachments' | 'sidecars'

export interface SweepResult extends GcPlan {
  applied: boolean
  failed: readonly string[]
  /** Classes planned as NOTHING because their store could not be read. */
  skipped: readonly SweepClass[]
}

/** A sidecar directory emptied by the sweep has no meaning left; drop it. */
function removeEmptiedSidecarDirs(roots: StorageRoots, removed: readonly string[]): void {
  const teams = path.resolve(roots.teams)
  const dirs = new Set(
    removed
      .filter((file) => path.resolve(path.dirname(path.dirname(file))) === teams)
      .filter((file) => path.basename(path.dirname(file)).endsWith(SIDECAR_SUFFIX))
      .map((file) => path.dirname(file))
  )
  for (const dir of dirs) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir)
    } catch {
      // Already gone, or someone wrote into it mid-sweep — either is fine.
    }
  }
}

/**
 * Plan (and optionally perform) the sweep.
 *
 * Aborts by planning NOTHING when the workspace store is missing: an absent
 * canvas store is indistinguishable from "every terminal is dead", and that
 * reading would delete every ledger on the machine. Refusing to collect is the
 * only safe answer to a store we cannot see. The same reasoning, per class,
 * empties the sidecar candidates when any team JSON is unreadable.
 */
export function sweepStorage(options: SweepOptions = {}): SweepResult {
  const roots = options.roots ?? defaultStorageRoots()
  const empty: SweepResult = {
    remove: [],
    bytes: 0,
    kept: { live: 0, withinGrace: 0 },
    applied: false,
    failed: [],
    skipped: []
  }
  if (!existsSync(roots.workspaces)) return empty

  const attachments = candidatesIn(roots.attachments, (f) => path.basename(f))
  const referencedSidecars = collectReferencedSidecars(roots)
  const plan = planStorageGc({
    ledgers: candidatesIn(roots.turns, terminalIdOf),
    attachments,
    sidecars: referencedSidecars === null ? [] : sidecarCandidates(roots),
    liveTerminalIds: collectLiveTerminalIds(roots),
    referencedAttachments: collectReferencedAttachments(
      roots,
      attachments.map((a) => a.key)
    ),
    referencedSidecars: referencedSidecars ?? new Set<string>(),
    now: options.now ?? Date.now(),
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS
  })
  const skipped: SweepClass[] = referencedSidecars === null ? ['sidecars'] : []
  if (options.apply !== true) return { ...plan, applied: false, failed: [], skipped }

  const failed: string[] = []
  const removed: string[] = []
  for (const target of plan.remove) {
    try {
      rmSync(target.path, { force: true })
      removed.push(target.path)
    } catch {
      failed.push(target.path)
    }
  }
  removeEmptiedSidecarDirs(roots, removed)
  return { ...plan, applied: true, failed, skipped }
}
