import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { planStorageGc, type GcCandidate, type GcPlan } from './storage-gc'

/**
 * The disk half of the storage sweep: read the stores, build the two reference
 * sets, hand both to the pure planner, and — only when asked — unlink.
 *
 * The reference sets are collected by SCANNING rather than from an index,
 * because no index exists: nothing ever recorded which attachment a turn cited.
 * A scan can only err toward "referenced" if it reads too much, which is the
 * safe direction, so it reads every store that could name one.
 */

const DAY = 24 * 60 * 60 * 1000
/** Conservative on purpose — see the grace-period reasoning in storage-gc.ts. */
export const DEFAULT_GRACE_MS = 30 * DAY

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

function candidatesIn(dir: string, keyOf: (file: string) => string): GcCandidate[] {
  return walk(dir).map((file) => {
    const stat = statSync(file)
    return { key: keyOf(file), path: file, bytes: stat.size, mtimeMs: stat.mtimeMs }
  })
}

/** A ledger file is `<terminalId>.jsonl`; `.migrated` siblings share the id. */
const terminalIdOf = (file: string): string => path.basename(file).split('.')[0]

export interface SweepOptions {
  roots?: StorageRoots
  now?: number
  graceMs?: number
  /** False plans without unlinking — the dry run is the same code path. */
  apply?: boolean
}

export interface SweepResult extends GcPlan {
  applied: boolean
  failed: readonly string[]
}

/**
 * Plan (and optionally perform) the sweep.
 *
 * Aborts by planning NOTHING when the workspace store is missing: an absent
 * canvas store is indistinguishable from "every terminal is dead", and that
 * reading would delete every ledger on the machine. Refusing to collect is the
 * only safe answer to a store we cannot see.
 */
export function sweepStorage(options: SweepOptions = {}): SweepResult {
  const roots = options.roots ?? defaultStorageRoots()
  const empty: SweepResult = {
    remove: [],
    bytes: 0,
    kept: { live: 0, withinGrace: 0 },
    applied: false,
    failed: []
  }
  if (!existsSync(roots.workspaces)) return empty

  const attachments = candidatesIn(roots.attachments, (f) => path.basename(f))
  const plan = planStorageGc({
    ledgers: candidatesIn(roots.turns, terminalIdOf),
    attachments,
    liveTerminalIds: collectLiveTerminalIds(roots),
    referencedAttachments: collectReferencedAttachments(
      roots,
      attachments.map((a) => a.key)
    ),
    now: options.now ?? Date.now(),
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS
  })
  if (options.apply !== true) return { ...plan, applied: false, failed: [] }

  const failed: string[] = []
  for (const target of plan.remove) {
    try {
      rmSync(target.path, { force: true })
    } catch {
      failed.push(target.path)
    }
  }
  return { ...plan, applied: true, failed }
}
