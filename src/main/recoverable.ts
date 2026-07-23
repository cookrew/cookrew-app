// Recovery snapshots (agent-recover feature): when a terminal is killed
// (removeNode hard-deletes node + edges + turn history), we first snapshot
// everything a full restore needs — the node itself (position, size, session
// refs, orch/role/preset/command/cwd), its owning workspace, and its peer
// edges — into ~/.cookrew/recoverable.json. recoverAgent restores from it so
// a killed teammate comes back exactly as it was, on its own session.
//
// Harness-agnostic by construction: the node carries whatever session ref its
// harness uses (claudeSessionId / codexSessionRef / opencodeSessionId), so a
// new harness needs no change here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { TerminalNodeData } from '../shared/model'

export interface RecoverableSnapshot {
  node: TerminalNodeData
  workspaceId: string
  workspaceName: string
  /** Peer node ids this terminal was connected to (edges), for reconnection. */
  peers: string[]
  savedAt: number
}

function isSnapshot(v: unknown): v is RecoverableSnapshot {
  const s = v as RecoverableSnapshot
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.node === 'object' &&
    s.node !== null &&
    typeof (s.node as TerminalNodeData).id === 'string' &&
    typeof s.workspaceId === 'string' &&
    Array.isArray(s.peers)
  )
}

export class RecoverableStore {
  private byId = new Map<string, RecoverableSnapshot>()

  constructor(private file = path.join(homedir(), '.cookrew', 'recoverable.json')) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) {
        for (const s of parsed) if (isSnapshot(s)) this.byId.set(s.node.id, s)
      }
    } catch (error) {
      console.error('Failed to load recoverable snapshots:', error)
    }
  }

  /** Retained snapshots (newest by savedAt); older ones are evicted. */
  private static readonly MAX = 100

  private save(): void {
    try {
      // Cap unbounded growth (MEDIUM-4): keep the newest MAX by savedAt.
      const kept = [...this.byId.values()]
        .sort((a, b) => b.savedAt - a.savedAt)
        .slice(0, RecoverableStore.MAX)
      if (kept.length < this.byId.size) {
        this.byId = new Map(kept.map((s) => [s.node.id, s]))
      }
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(kept, null, 2), 'utf8')
    } catch (error) {
      console.error('Failed to save recoverable snapshots:', error)
    }
  }

  /** Snapshot a terminal at kill time (upsert by node id). */
  capture(snapshot: RecoverableSnapshot): void {
    this.byId.set(snapshot.node.id, snapshot)
    this.save()
  }

  get(id: string): RecoverableSnapshot | undefined {
    return this.byId.get(id)
  }

  /** Drop a snapshot once its agent has been recovered. */
  remove(id: string): void {
    if (this.byId.delete(id)) this.save()
  }

  list(): RecoverableSnapshot[] {
    return [...this.byId.values()]
  }
}


// ---- recovery planning (pure — the Conductor's edge/boot rules, testable) ----

export interface RecoveryContext {
  activeWorkspaceId: string
  workspaceExists: (id: string) => boolean
  /** True when a node id still exists on some canvas (a surviving peer). */
  nodeExists: (id: string) => boolean
  /** True when a surviving peer id is itself an orch terminal. */
  isOrch: (id: string) => boolean
  /** The active workspace's orch id, for reachability wiring. */
  currentOrchId: string | null
}

export interface RecoveryPlan {
  targetWorkspaceId: string
  /** Surviving snapshot peers to reconnect. */
  peerEdges: string[]
  /** Extra orch edge for reachability, or null (a surviving peer already is one). */
  orchEdge: string | null
  /** Boot the PTY now (target workspace active) vs defer to activation. */
  spawn: boolean
}

/**
 * Plan a recovery from a kill snapshot (agent-recover, Conductor's rules):
 * restore SURVIVING peers first; only if none reaches an orch, wire to the
 * current orch (never duplicating an orch edge the snapshot provides). Boot
 * the PTY only when the target workspace is active — an inactive workspace
 * recovers registry-consistent, deferring the PTY to activation. A vanished
 * source workspace falls back to the active one.
 */
export function planRecovery(snap: RecoverableSnapshot, ctx: RecoveryContext): RecoveryPlan {
  const targetWorkspaceId = ctx.workspaceExists(snap.workspaceId)
    ? snap.workspaceId
    : ctx.activeWorkspaceId
  const peerEdges = snap.peers.filter((id) => ctx.nodeExists(id))
  const reachesOrch = peerEdges.some((id) => ctx.isOrch(id))
  const orchEdge =
    reachesOrch || ctx.currentOrchId === null || ctx.currentOrchId === snap.node.id
      ? null
      : ctx.currentOrchId
  return { targetWorkspaceId, peerEdges, orchEdge, spawn: targetWorkspaceId === ctx.activeWorkspaceId }
}
