// Endpoint restore executor — rewind a live teammate IN PLACE to any checkpoint
// and undo that rewind. Keeps the original session file untouched.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CanvasNode, RestoreResult, TerminalNodeData } from '../shared/model'
import { restorePointIndex } from '../shared/model'
import { buildForkedSessionLinesAtUuid } from '../shared/claude-fork'
import { harnessFor } from './harness'
import { planCheckpointRestore, pushRestorePoint } from './restore-plan'
import { withSessionLineage } from './session-lineage'
import { claudeSessionFile, isSessionUuid } from './claude-fork'

export interface RestoreExecutorDeps {
  store: {
    nodeAcrossWorkspaces(id: string): { node: CanvasNode; workspaceId: string } | undefined
    updateNodeUnsafe(id: string, patch: Partial<CanvasNode>): CanvasNode | undefined
  }
  ptys: {
    killAndWait(terminalId: string, timeoutMs?: number): Promise<void>
  }
  traces: {
    checkpointRefs(terminalId: string): Promise<{ index: number; id: string }[]>
  }
  spawnTracked: (
    node: Pick<TerminalNodeData, 'id' | 'command' | 'cwd' | 'claudeSessionId' | 'codexSessionRef' | 'opencodeSessionId'>
  ) => void
  /**
   * Live turn phase for a terminal ('idle' | 'thinking' | 'waiting' |
   * 'replied'), null when untracked. Restore/undo KILL the CLI — doing that
   * while it is mid-turn (thinking/waiting) can tear the session JSONL as it
   * is being written, so both paths refuse unless the agent is quiet.
   */
  phaseOf?: (id: string) => string | null
  /** Override for tests; defaults to ~/.claude/projects. */
  projectsDir?: string
}

export function createRestoreHandlers(deps: RestoreExecutorDeps): {
  restoreCheckpoint: (id: string, checkpointIndex: number) => Promise<RestoreResult>
  undoRestore: (id: string) => Promise<RestoreResult>
} {
  // H3: per-terminal async mutex. IPC (desktop) and HTTP (phone) both reach
  // this executor; two concurrent restores on the SAME terminal would each
  // pass the busy check, both kill, and the second rebind would clobber the
  // first's lineage/undo stack. Chain each op onto the terminal's tail so
  // restore/undo on one terminal strictly serialize (different terminals
  // still run in parallel). The tail self-cleans when it settles.
  const tails = new Map<string, Promise<unknown>>()
  const serialized = <T>(id: string, op: () => Promise<T>): Promise<T> => {
    const tail = tails.get(id) ?? Promise.resolve()
    const next = tail.then(op, op)
    tails.set(id, next)
    void next
      .catch(() => undefined)
      .finally(() => {
        if (tails.get(id) === next) tails.delete(id)
      })
    return next
  }
  return {
    restoreCheckpoint: (id, checkpointIndex) =>
      serialized(id, () => restoreCheckpoint(deps, id, checkpointIndex)),
    undoRestore: (id) => serialized(id, () => undoRestore(deps, id))
  }
}

export type RestoreHandlers = ReturnType<typeof createRestoreHandlers>

/** Minimal `ipcMain.handle` surface, so the IPC block is unit-testable and
 *  index.ts doesn't have to know the channel names (M10). */
export type IpcHandleFn = (
  channel: string,
  // `unknown` args, not `never[]`: electron's own `ipcMain.handle` takes
  // `...args: any[]`, and `any` is assignable to everything EXCEPT `never` —
  // so a `never[]` rest made `ipcMain.handle` itself unassignable here.
  listener: (event: unknown, ...args: unknown[]) => unknown
) => void

/**
 * Register the endpoint-restore IPC channels. Lives alongside the executor
 * (M10) so the channel names, argument order, and handler delegation change
 * in ONE file instead of across index.ts's IPC block.
 */
export function registerRestoreIpc(handle: IpcHandleFn, handlers: RestoreHandlers): void {
  // Renderer-supplied args arrive untyped; the handlers validate the id and
  // index themselves (unknown terminal / out-of-range checkpoint both fail
  // closed with a RestoreResult), so this boundary only restores the shapes.
  handle('agent:restore-checkpoint', (_e, id, checkpointIndex) =>
    handlers.restoreCheckpoint(id as string, checkpointIndex as number)
  )
  handle('agent:undo-restore', (_e, id) => handlers.undoRestore(id as string))
}

async function restoreCheckpoint(
  deps: RestoreExecutorDeps,
  id: string,
  checkpointIndex: number
): Promise<RestoreResult> {
  const hit = deps.store.nodeAcrossWorkspaces(id)
  if (!hit || hit.node.kind !== 'terminal') {
    return fail(id, '', checkpointIndex, `No terminal '${id}' found.`)
  }
  const node = hit.node as TerminalNodeData
  const harness = harnessFor(node.command)
  if (!harness || harness.id !== 'claude') {
    return fail(id, node.name, checkpointIndex, planCheckpointRestore({
      command: node.command,
      sessionId: node.claudeSessionId,
      checkpointIndex,
      blocks: []
    }).reason ?? 'Endpoint restore is only supported for Claude Code.')
  }
  if (!node.claudeSessionId) {
    return fail(id, node.name, checkpointIndex, 'No bound Claude session file for this agent yet.')
  }
  // M1: every id that reaches claudeSessionFile (a bare path.join) must be
  // UUID-shaped — a tampered store file ('../../etc/x' as session id) would
  // otherwise escape the project dir and copy an arbitrary *.jsonl into a
  // session the agent will load. Refuse honestly at the executor boundary.
  if (!isSessionUuid(node.claudeSessionId)) {
    return fail(id, node.name, checkpointIndex, 'The bound session id is malformed — refusing to restore.')
  }

  const busy = busyReason(deps, id)
  if (busy) return fail(id, node.name, checkpointIndex, busy)

  const blocks = await deps.traces.checkpointRefs(id)
  const plan = planCheckpointRestore({
    command: node.command,
    sessionId: node.claudeSessionId,
    checkpointIndex,
    blocks
  })
  if (!plan.ok) {
    return fail(id, node.name, checkpointIndex, plan.reason ?? 'Restore not possible.')
  }
  if (plan.cutoffSessionId !== undefined && !isSessionUuid(plan.cutoffSessionId)) {
    return fail(id, node.name, checkpointIndex, 'The checkpoint session id is malformed — refusing to restore.')
  }

  const sourceFile = claudeSessionFile(node.cwd, plan.cutoffSessionId ?? node.claudeSessionId, deps.projectsDir)
  if (!existsSync(sourceFile)) {
    return fail(id, node.name, checkpointIndex, 'The bound session file no longer exists.')
  }

  const sourceLines = readFileSync(sourceFile, 'utf8').split('\n')
  const newSessionId = randomUUID()
  const truncated = buildForkedSessionLinesAtUuid(sourceLines, {
    newSessionId,
    cutoffUuid: plan.cutoffUuid!
  })
  if (truncated.length === 0) {
    return fail(id, node.name, checkpointIndex, 'Checkpoint produced an empty session — refusing to restore.')
  }

  // H1: the entry busy check is stale by now — checkpointRefs awaited a
  // potentially multi-MB read+parse, during which the agent can go
  // idle→thinking (user types, a routine fires). Re-check immediately before
  // the kill (only synchronous work intervenes) so a mid-turn CLI is never
  // torn while writing the session file undo depends on.
  const stillBusy = busyReason(deps, id)
  if (stillBusy) return fail(id, node.name, checkpointIndex, stillBusy)

  const destFile = claudeSessionFile(node.cwd, newSessionId, deps.projectsDir)
  const previousSessionId = node.claudeSessionId
  try {
    mkdirSync(path.dirname(destFile), { recursive: true })
    writeFileSync(destFile, `${truncated.join('\n')}\n`, 'utf8')
    await deps.ptys.killAndWait(id)
  } catch (error) {
    // H2: failure BEFORE the rebind — the node still points at the original
    // session (a kill timeout leaves the old tmux session alive), so drop
    // the orphaned truncated copy and report honestly.
    unlinkIfExists(destFile)
    return fail(id, node.name, checkpointIndex, `Restore failed before rebind: ${errorMessage(error)}`)
  }

  const updated = deps.store.updateNodeUnsafe(id, {
    ...withSessionLineage(node, newSessionId),
    restoreStack: pushRestorePoint(node.restoreStack ?? [], {
      sessionId: previousSessionId as string,
      at: Date.now(),
      rewoundToIndex: checkpointIndex
    })
  })
  if (!updated || updated.kind !== 'terminal') {
    // H2: the kill already landed but the rebind failed (node removed from
    // another workspace mid-restore) — respawn with the ORIGINAL binding so
    // the agent is never silently left dead, and drop the orphaned copy.
    unlinkIfExists(destFile)
    trySpawn(deps, node)
    return fail(id, node.name, checkpointIndex, 'Failed to rebind the agent to the restored session.')
  }

  deps.spawnTracked(updated as TerminalNodeData)

  return {
    ok: true,
    id,
    name: node.name,
    checkpointIndex,
    sessionId: newSessionId,
    previousSessionId
  }
}

async function undoRestore(deps: RestoreExecutorDeps, id: string): Promise<RestoreResult> {
  const hit = deps.store.nodeAcrossWorkspaces(id)
  if (!hit || hit.node.kind !== 'terminal') {
    return fail(id, '', 0, `No terminal '${id}' found.`)
  }
  const node = hit.node as TerminalNodeData
  const stack = node.restoreStack ?? []
  if (stack.length === 0) {
    return fail(id, node.name, 0, 'Nothing to undo.')
  }

  const [point, ...rest] = stack
  if (!isSessionUuid(point.sessionId)) {
    return fail(id, node.name, restorePointIndex(point), 'The undo stack session id is malformed — refusing to undo.')
  }
  const targetFile = claudeSessionFile(node.cwd, point.sessionId, deps.projectsDir)
  if (!existsSync(targetFile)) {
    return fail(id, node.name, restorePointIndex(point), 'The previous session file no longer exists — cannot undo.')
  }

  const busy = busyReason(deps, id)
  if (busy) return fail(id, node.name, restorePointIndex(point), busy)

  try {
    await deps.ptys.killAndWait(id)
  } catch (error) {
    // H2: a failed (timed-out) kill leaves the original session running and
    // the node untouched — report honestly instead of rebinding blind.
    return fail(id, node.name, restorePointIndex(point), `Undo failed before rebind: ${errorMessage(error)}`)
  }

  const updated = deps.store.updateNodeUnsafe(id, {
    ...withSessionLineage(node, point.sessionId),
    restoreStack: rest
  })
  if (!updated || updated.kind !== 'terminal') {
    // H2: killed but not rebound — respawn with the original binding.
    trySpawn(deps, node)
    return fail(id, node.name, restorePointIndex(point), 'Failed to rebind the agent during undo.')
  }

  deps.spawnTracked(updated as TerminalNodeData)

  return {
    ok: true,
    id,
    name: node.name,
    checkpointIndex: restorePointIndex(point),
    sessionId: point.sessionId,
    previousSessionId: node.claudeSessionId,
    undone: true
  }
}

/**
 * Refusal reason when the agent is mid-turn, null when it is safe to kill.
 * 'thinking'/'waiting' mean the CLI may be writing the session file right
 * now; 'replied'/'idle'/untracked are quiet.
 */
function busyReason(deps: RestoreExecutorDeps, id: string): string | null {
  const phase = deps.phaseOf?.(id)
  if (phase === 'thinking' || phase === 'waiting') {
    return `Agent is ${phase} — wait for the turn to finish before rewinding.`
  }
  return null
}

/** Best-effort rollback respawn — never mask the original failure. */
function trySpawn(deps: RestoreExecutorDeps, node: TerminalNodeData): void {
  try {
    deps.spawnTracked(node)
  } catch {
    // The agent stays down; the returned failure already says the rebind failed.
  }
}

function unlinkIfExists(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Already gone (or never written).
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(
  id: string,
  name: string,
  checkpointIndex: number,
  reason: string
): RestoreResult {
  return { ok: false, id, name, checkpointIndex, reason }
}
