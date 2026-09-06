import { existsSync, readdirSync, readFileSync, rmSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { roleSlug } from './roles'
import { planStorageGc, type GcCandidate, type GcPlan } from './storage-gc'
import { isResidueName, scanResidue, type ResidueEntry } from './storage-gc-residue'
import { dirTouchedWithinGrace, servedSessionCandidates, writtenSincePlan } from './storage-gc-served'

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
  /** The store itself (~/.cookrew): where hand-made backup residue is found. */
  base: string
  /** Served-session sandboxes, `sessions/<service>/<session>`. */
  sessions: string
  turns: string
  attachments: string
  workspaces: string
  teams: string
  annotations: string
}

export function defaultStorageRoots(base = path.join(homedir(), '.cookrew')): StorageRoots {
  return {
    base,
    sessions: path.join(base, 'sessions'),
    turns: path.join(base, 'turns'),
    attachments: path.join(base, 'attachments'),
    workspaces: path.join(base, 'workspaces'),
    teams: path.join(base, 'teams'),
    annotations: path.join(base, 'checkpoint-annotations')
  }
}

/**
 * `readdirSync` that answers empty for a directory that is gone or unreadable.
 * `pruneSessionSidecars` removes a whole sidecar dir when a team's map empties,
 * and a sweep that started a moment earlier must not lose every class to it.
 */
function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Every file under `dir`, recursively. Missing directories answer empty. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of safeReaddir(dir)) {
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

/**
 * The sidecar key a team resolves for one of its sessions-map values — the
 * same `roleSlug` `TeamStore.sessionsDirFor` uses, so the two cannot drift.
 */
const sidecarKey = (teamName: string, fileName: string): string =>
  path.join(`${roleSlug(teamName)}${SIDECAR_SUFFIX}`, fileName)

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
 * resolves `<roleSlug(team.name)>-sessions/<sessions[id]>`, and nothing else
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
  let entries: Dirent[]
  try {
    entries = readdirSync(roots.teams, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
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
    // A hand-made copy inside a store (`turns/<id>.jsonl.bak-…`) would key
    // as the ledger it backs up and be collected with it. It is residue:
    // reported, never a candidate.
    if (isResidueName(path.basename(file))) continue
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
  return safeReaddir(roots.teams)
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
  /**
   * servedSessionKey of every session OPEN in the instantiator, from index.ts.
   * An array, not a Set, because it crosses into the sweep worker by
   * structured clone. Absent or null: unknown, and the served class is not
   * planned — the boot sweep always says (an empty list at boot, since served
   * sessions die with the app).
   */
  openServedSessions?: readonly string[] | null
}

/** A candidate class the sweep knows how to plan. */
export type SweepClass = 'ledgers' | 'attachments' | 'sidecars' | 'served'
const EVERY_CLASS: readonly SweepClass[] = ['ledgers', 'attachments', 'sidecars', 'served']

export interface SweepResult extends GcPlan {
  applied: boolean
  failed: readonly string[]
  /**
   * Classes planned as NOTHING because a store could not be read — every
   * class, since one unreadable store (a missing canvas root, a half-written
   * team JSON) names references for all of them. A sessions root that cannot
   * be read names nothing for the others, so it skips `served` alone. Empty
   * on a normal sweep.
   */
  skipped: readonly SweepClass[]
  /**
   * Hand-made backup copies (`*.bak-*`, `lineage-restore-backup-*`, …),
   * largest first. REPORTED, never in `remove`: the app did not make them
   * and does not delete them. See storage-gc-residue.ts.
   */
  residue: readonly ResidueEntry[]
  residueBytes: number
}

/**
 * Plan (and optionally perform) the sweep.
 *
 * Aborts by planning NOTHING when the workspace store is missing: an absent
 * canvas store is indistinguishable from "every terminal is dead", and that
 * reading would delete every ledger on the machine. Refusing to collect is the
 * only safe answer to a store we cannot see. An unreadable team JSON is the
 * same store-you-cannot-read for EVERY class — it names terminal ids and
 * attachments as well as sidecars — so it aborts all three, and `skipped`
 * says which classes were planned as nothing and why nothing was freed.
 *
 * Candidates are listed BEFORE references are read, in every class. A
 * `TeamStore.save` landing between the two passes then adds a reference the
 * candidate list predates (kept, harmlessly) rather than a candidate the
 * reference set predates (which would look orphaned).
 */
export function sweepStorage(options: SweepOptions = {}): SweepResult {
  const roots = options.roots ?? defaultStorageRoots()
  // The report half has nothing to abort: residue is named even on a sweep
  // that refuses to plan.
  const residue = scanResidue(roots.base)
  const residueBytes = residue.reduce((sum, r) => sum + r.bytes, 0)
  const empty: SweepResult = {
    remove: [],
    bytes: 0,
    kept: { live: 0, withinGrace: 0 },
    applied: false,
    failed: [],
    skipped: EVERY_CLASS,
    residue,
    residueBytes
  }
  if (!existsSync(roots.workspaces)) return empty

  // Served sessions: the open set is the app's to state. Not stated, and the
  // class is not planned — a caller's choice, not a skip. Stated, and the
  // sandboxes are listed here with every other candidate class, before any
  // reference is read; a sessions root that exists but cannot be read (null
  // from the scan) skips this class alone, since it names nothing for the
  // others.
  const openServed =
    options.openServedSessions == null ? undefined : new Set(options.openServedSessions)
  const servedScan = openServed === undefined ? [] : servedSessionCandidates(roots.sessions)
  const served = servedScan ?? []
  const skipped: SweepClass[] = servedScan === null ? ['served'] : []

  const ledgers = candidatesIn(roots.turns, terminalIdOf)
  const attachments = candidatesIn(roots.attachments, (f) => path.basename(f))
  const sidecars = sidecarCandidates(roots)
  const referencedSidecars = collectReferencedSidecars(roots)
  if (referencedSidecars === null) return empty

  const plan = planStorageGc({
    ledgers,
    attachments,
    sidecars,
    liveTerminalIds: collectLiveTerminalIds(roots),
    referencedAttachments: collectReferencedAttachments(
      roots,
      attachments.map((a) => a.key)
    ),
    referencedSidecars,
    servedSessions: served,
    openServedSessions: openServed,
    now: options.now ?? Date.now(),
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS
  })
  if (options.apply !== true) return { ...plan, applied: false, failed: [], skipped, residue, residueBytes }

  const now = options.now ?? Date.now()
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const failed: string[] = []
  const removed: GcCandidate[] = []
  let spared = 0
  for (const target of plan.remove) {
    // A directory candidate is a served sandbox, and the plan is seconds old
    // by now. A mint that landed on it since (see writtenSincePlan) makes it
    // recent again, and recent is kept — the same grace rule, asked at the
    // last possible moment.
    if (writtenSincePlan(target, now, graceMs)) {
      spared += 1
      continue
    }
    // That walk took time. One stat of the directory itself — the thing a
    // mint touches — right before the unlink is the last word.
    if (dirTouchedWithinGrace(target.path, now, graceMs)) {
      spared += 1
      continue
    }
    try {
      // Recursive because a served-session candidate is a whole sandbox
      // directory; on a file it changes nothing.
      rmSync(target.path, { recursive: true, force: true })
      removed.push(target)
    } catch {
      failed.push(target.path)
    }
  }
  return {
    ...plan,
    // What was actually removed — not what was planned, not what failed —
    // so the boot log's count and bytes never include a sandbox spared at
    // the last moment or a file that is still there.
    remove: removed,
    bytes: removed.reduce((sum, c) => sum + c.bytes, 0),
    kept: { ...plan.kept, withinGrace: plan.kept.withinGrace + spared },
    applied: true,
    failed,
    skipped,
    residue,
    residueBytes
  }
}
