import { openMachine } from './machine-opener'
import { callRemote } from './use-remote-machine'

/**
 * A FACE OF ANOTHER MACHINE, OPENED FROM THE BAR (phase 6, plan
 * docs/hitl-cross-workspace-2026-11-15 · v6.2). The bar enters that machine
 * (machine-opener.ts: its own app, as the console draws it) straight at the
 * face: an agent's full view in the workspace its fleet named, or an
 * artifact's in that workspace's artifacts. Where the machine no longer holds
 * it, that machine's own app says so, as it would for one of its own.
 */

/** What the bar knows of a face it opens on another machine (remote-hitl.ts entries). */
export interface RemoteFace {
  readonly machineId: string
  readonly machineName: string
  readonly machineOs: string | null
  readonly workspaceId: string
  readonly workspaceName: string
  readonly kind: 'agent' | 'item'
  readonly id: string
  readonly name: string
  readonly itemKind?: 'note' | 'browser'
}

/** Into that machine, at the face. The zoom stays where it is: the machine stands over it, and leaving comes back here. */
export function openRemoteFace(face: RemoteFace): void {
  openMachine({
    machine: { id: face.machineId, name: face.machineName, os: face.machineOs },
    entry: face.kind === 'agent' ? { workspace: face.workspaceId, agent: face.id } : { workspace: face.workspaceId, item: face.id, side: 'items' }
  })
}

/** A reply opened on its card is read, on its own machine (the allow-listed POST api/terminal/:id/seen). */
export function readRemoteReply(machineId: string, agentId: string): void {
  void callRemote(machineId, 'POST', `api/terminal/${encodeURIComponent(agentId)}/seen`)
}
