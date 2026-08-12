// SELECT-mode clipboard: copy/cut a selection of canvas nodes, paste it
// into whichever workspace is active later. Lives outside index.ts so the
// lifecycle (staleness pruning, cut ordering, re-entrancy) is unit-testable
// with plain fakes.

import type {
  CanvasNode,
  TeamClipStatus,
  TeamCopyResult,
  TeamCopySpec,
  WorkspaceMeta,
  WorkspaceState
} from '../shared/model'

export interface TeamClipDeps {
  activeId: () => string
  workspaces: () => WorkspaceMeta[]
  workspaceState: (id: string) => WorkspaceState
  activeNodes: () => CanvasNode[]
  /** Is this terminal mid-turn on the ACTIVE canvas? See UNCOPYABLE_PHASES. */
  isWorking: (terminalId: string) => boolean
  /** The copy engine (copyTeam bound to its deps). */
  paste: (spec: TeamCopySpec) => Promise<TeamCopyResult>
  /**
   * Remove the cut sources AFTER a successful paste. Owns the per-node
   * teardown: an active-workspace node has a live process/browser behind it
   * that must die with the card — state-only removal would leak an
   * invisible agent that keeps running (and burning) forever.
   */
  removeCut: (nodeIds: string[], fromWorkspaceId: string) => Promise<void>
}

interface Clip {
  nodeIds: string[]
  fromWorkspaceId: string
  cut: boolean
  /** Paste spawns the copies into a fresh worktree of this name. */
  worktreeName?: string
}

export class TeamClipboard {
  private clip: Clip | null = null
  private pasteInFlight: Promise<TeamCopyResult> | null = null

  constructor(private deps: TeamClipDeps) {}

  /** Stage a copy/cut of active-canvas nodes. Working agents refuse, by name. */
  set(nodeIds: string[], cut: boolean, worktree?: { name: string }): TeamClipStatus {
    if (!Array.isArray(nodeIds) || !nodeIds.every((id) => typeof id === 'string')) {
      throw new Error('Clipboard needs nodeIds as a string[]')
    }
    const chosen = this.deps.activeNodes().filter((n) => nodeIds.includes(n.id))
    if (chosen.length === 0) throw new Error(`Nothing selected to ${cut ? 'cut' : 'copy'}`)
    // The same guard paste enforces, but failing NOW — at the gesture —
    // beats failing later on a paste in another workspace.
    const working = chosen.filter((n) => n.kind === 'terminal' && this.deps.isWorking(n.id))
    if (working.length > 0) {
      const names = working.map((n) => `“${n.name}”`).join(', ')
      throw new Error(
        `Working agents can't be ${cut ? 'cut' : 'copied'} — wait for ${names} to finish`
      )
    }
    // Worktree shape checks belong at the gesture too; the authoritative
    // is-it-a-repo / fresh-name verification runs at paste (copyTeam).
    let worktreeName: string | undefined
    if (worktree) {
      worktreeName = typeof worktree.name === 'string' ? worktree.name.trim() : ''
      if (!worktreeName) throw new Error('Name the worktree first')
      const cwds = new Set(
        chosen.filter((n) => n.kind === 'terminal').map((n) => (n as { cwd: string }).cwd)
      )
      if (cwds.size === 0) throw new Error('Worktree paste needs at least one agent selected')
      if (cwds.size > 1) throw new Error('Worktree paste needs every selected agent in ONE workdir')
    }
    this.clip = {
      nodeIds: chosen.map((n) => n.id),
      fromWorkspaceId: this.deps.activeId(),
      cut: cut === true,
      ...(worktreeName ? { worktreeName } : {})
    }
    return this.status() as TeamClipStatus
  }

  /** Clipboard contents, pruned against reality; null when nothing to paste. */
  status(): TeamClipStatus | null {
    if (!this.clip) return null
    const from = this.deps.workspaces().find((w) => w.id === this.clip?.fromWorkspaceId)
    if (!from) {
      this.clip = null
      return null
    }
    const state = this.deps.workspaceState(from.id)
    const staged = new Set(this.clip.nodeIds)
    const items = state.nodes
      .filter((n) => staged.has(n.id))
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        position: n.position,
        size: n.size,
        moves: this.clip?.cut === true && n.kind !== 'terminal'
      }))
    if (items.length === 0) {
      this.clip = null
      return null
    }
    // The cables that would travel: both ends staged — the same rule the
    // paste applies, so the thumbnail never promises a cable paste drops.
    const cables = state.connections
      .filter((c) => staged.has(c.a) && staged.has(c.b))
      .map((c) => ({ a: c.a, b: c.b }))
    return {
      count: items.length,
      fromWorkspaceName: from.name,
      fromWorkspaceId: from.id,
      cut: this.clip.cut,
      ...(this.clip.worktreeName ? { worktreeName: this.clip.worktreeName } : {}),
      items,
      cables
    }
  }

  /**
   * Paste into the ACTIVE workspace. Copy first, remove sources after — a
   * cut whose paste fails must leave the originals standing. A cut clears
   * the clipboard on success (the sources are gone); a copy keeps it for
   * repeats. One paste at a time: the clipboard is shared IPC/HTTP state
   * and a concurrent second paste of a cut would double the copies.
   */
  async paste(): Promise<TeamCopyResult> {
    if (this.pasteInFlight) throw new Error('A paste is already in progress')
    this.pasteInFlight = this.pasteInner()
    try {
      return await this.pasteInFlight
    } finally {
      this.pasteInFlight = null
    }
  }

  private async pasteInner(): Promise<TeamCopyResult> {
    const clip = this.clip
    if (!clip || this.status() === null) {
      throw new Error('Nothing to paste — copy or cut a selection first')
    }
    if (clip.cut && clip.fromWorkspaceId === this.deps.activeId()) {
      throw new Error(
        'Cut and paste in the same workspace would rebuild these agents — use COPY, or paste in another workspace'
      )
    }
    // CUT moves ownership outright for session-less kinds: notes and
    // browsers keep their id (profile, file) — no kill-and-recreate.
    // Terminals re-id and ride the copy machinery (session restore).
    const fromNodes = this.deps.workspaceState(clip.fromWorkspaceId).nodes
    const moveIds = clip.cut
      ? fromNodes
          .filter((n) => clip.nodeIds.includes(n.id) && n.kind !== 'terminal')
          .map((n) => n.id)
      : []
    const result = await this.deps.paste({
      nodeIds: clip.nodeIds,
      intoWorkspaceId: this.deps.activeId(),
      fromWorkspaceId: clip.fromWorkspaceId,
      ...(clip.worktreeName ? { worktree: { name: clip.worktreeName } } : {}),
      ...(moveIds.length > 0 ? { preserveIdentity: moveIds } : {})
    })
    if (clip.cut) {
      await this.deps.removeCut(clip.nodeIds, clip.fromWorkspaceId)
      this.clip = null
    }
    return result
  }
}
