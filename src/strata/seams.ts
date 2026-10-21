/**
 * THE SEAMS between the shell's own parts. src/shared/strata.ts is what crosses
 * the wire (desktop, registry, shell); this file is what crosses parts inside
 * the browser, so each can be built against a stand-in while the others land.
 * A seam changes for every part at once or not at all.
 *
 *   levels ──scene(path)──▶ stage    the stage mounts scenes and flies between them
 *   levels ──useAnchor()──▶ stage    every drawn item registers its element
 *   levels ──FigureKit────▶ figures  pure, memoized SVG for machines/containers/avatars
 *   levels ◀─UseFleet───── fleet     StrataMachine rows, live, plus a cross-machine index
 *   levels ──EmbedPool────▶ embed    the dive's last step: the agent's real terminal
 */
import type { ReactNode } from 'react'
import type {
  AgentPhase,
  AnchorId,
  FigureArt,
  Harness,
  LevelsAttachment,
  MachineKind,
  MachineLink,
  PhaseSource,
  StrataMachine,
  StrataPath
} from '../shared/strata'

// ── figures ─────────────────────────────────────────────────────────────────

/** dot = inside a machine's portal (level 0), small = in a container seen whole (level 1), full = level 2. */
export type AvatarSize = 'dot' | 'small' | 'full'

/** Same input → same string, so callers may memoize on the input and never redraw per frame. */
export interface FigureKit {
  /** reached false = never reached (no lastSeenAt and no levels): a dashed outline, not offline-with-cache. Default true. */
  machine(input: { kind: MachineKind; link: MachineLink; reached?: boolean }): FigureArt
  /**
   * The archetype comes from the workspace name alone (deterministic, no
   * network). `slots` seats avatars in creation order; beyond `capacity` the
   * last slot reads "+K".
   */
  container(input: { name: string; slots: number }): FigureArt & { archetype: string; capacity: number }
  /** `source` other than 'live' draws as last-known, never as fact. */
  avatar(input: { phase: AgentPhase; source: PhaseSource; harness: Harness; size: AvatarSize }): FigureArt
  attachment(input: { kind: LevelsAttachment['kind']; shared: boolean }): FigureArt
}

// ── stage ───────────────────────────────────────────────────────────────────

export interface StageProps {
  path: StrataPath
  /** One level's scene. During a flight the stage mounts two (outgoing and incoming). */
  scene: (path: StrataPath) => ReactNode
  /** Where "in" goes from here (the highlighted item), or null: the gesture rubber-bands. */
  inTarget: () => StrataPath | null
  /** A gesture committed a move. The owner of history pushes it, which changes `path`. */
  onCommit: (next: StrataPath) => void
  reducedMotion: boolean
}

/** Scenes call this for each drawn item; the stage reads the rects once per flight, never per frame. */
export type UseAnchor = (id: AnchorId) => (el: Element | null) => void

// ── fleet ───────────────────────────────────────────────────────────────────

export type UseFleet = () => StrataMachine[]

export interface AgentHit {
  machineId: string
  workspaceId: string
  agentId: string
  name: string
  /** Higher is better; equal scores keep fleet order (machine, workspace, creation). */
  score: number
}

/** Across every machine the shell can see, cached ones included. */
export interface FleetIndex {
  /** near breaks ties toward where the user is: the same workspace first, then the same machine. */
  find(query: string, limit?: number, near?: Pick<StrataPath, 'machine' | 'workspace'>): AgentHit[]
  /** Agents waiting on the owner, then replied-and-unread, oldest first. */
  attention(): AgentHit[]
}

// ── embed ───────────────────────────────────────────────────────────────────

export interface EmbedPool {
  /** Start that machine's companion document hidden, on hover intent or level entry. */
  prewarm(machineId: string): void
  /** Show the agent's terminal on the stage; rejects with the embed's error code. */
  open(path: Required<StrataPath>, attachmentId?: string): Promise<void>
  close(): void
}
