// Endpoint restore executor — rewind a live teammate IN PLACE to any checkpoint
// and undo that rewind. Keeps the original session file untouched.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CanvasNode, RestorePoint, RestoreResult, TerminalNodeData } from '../shared/model'
import { buildForkedSessionLinesAtUuid } from '../shared/claude-fork'
import { harnessFor } from './harness'
import { planCheckpointRestore, pushRestorePoint } from './restore-plan'
import { withSessionLineage } from './session-lineage'
import { claudeSessionFile } from './claude-fork'

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
  return {
    restoreCheckpoint: (id, checkpointIndex) => restoreCheckpoint(deps, id, checkpointIndex),
    undoRestore: (id) => undoRestore(deps, id)
  }
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

  const destFile = claudeSessionFile(node.cwd, newSessionId, deps.projectsDir)
  mkdirSync(path.dirname(destFile), { recursive: true })
  writeFileSync(destFile, `${truncated.join('\n')}\n`, 'utf8')

  const previousSessionId = node.claudeSessionId
  await deps.ptys.killAndWait(id)

  const updated = deps.store.updateNodeUnsafe(id, {
    ...withSessionLineage(node, newSessionId),
    restoreStack: pushRestorePoint(node.restoreStack ?? [], {
      sessionId: previousSessionId as string,
      at: Date.now(),
      fromIndex: checkpointIndex
    })
  })
  if (!updated || updated.kind !== 'terminal') {
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
  const targetFile = claudeSessionFile(node.cwd, point.sessionId, deps.projectsDir)
  if (!existsSync(targetFile)) {
    return fail(id, node.name, point.fromIndex, 'The previous session file no longer exists — cannot undo.')
  }

  const busy = busyReason(deps, id)
  if (busy) return fail(id, node.name, point.fromIndex, busy)

  await deps.ptys.killAndWait(id)

  const updated = deps.store.updateNodeUnsafe(id, {
    ...withSessionLineage(node, point.sessionId),
    restoreStack: rest
  })
  if (!updated || updated.kind !== 'terminal') {
    return fail(id, node.name, point.fromIndex, 'Failed to rebind the agent during undo.')
  }

  deps.spawnTracked(updated as TerminalNodeData)

  return {
    ok: true,
    id,
    name: node.name,
    checkpointIndex: point.fromIndex,
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

function fail(
  id: string,
  name: string,
  checkpointIndex: number,
  reason: string
): RestoreResult {
  return { ok: false, id, name, checkpointIndex, reason }
}
