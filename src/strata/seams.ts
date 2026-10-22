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
  EmbedToShell,
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
  /**
   * reached false = never reached (no lastSeenAt and no levels): a dashed outline, not offline-with-cache. Default true.
   * model = the hardware label, else the vendor model id (profile.label ?? profile.model): a desktop's
   * form (mini, tower, all-in-one) comes from it. Absent = a mini.
   */
  machine(input: { kind: MachineKind; link: MachineLink; reached?: boolean; model?: string | null }): FigureArt
  /**
   * One standard table for every workspace on every screen, longer for a
   * bigger crew; its theme comes from `traits` (closed words from the desktop)
   * and the name, deterministic, no network, and never changes the geometry.
   * `slots` seats avatars in creation order; beyond `capacity` the last slot
   * reads "+K".
   */
  container(input: { name: string; slots: number; traits?: readonly string[] }): FigureArt & { theme: string; capacity: number }
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

/**
 * True once the machine list has answered: from this browser's cache, live, or
 * with an error. Before that an empty fleet means "not yet", not "no machines".
 */
export type UseFleetLoaded = () => boolean

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

export type EmbedErrorCode = Extract<EmbedToShell, { type: 'strata:error' }>['code']

/** The same object until something changes, so React can select from it (useSyncExternalStore). */
export interface EmbedState {
  /** The terminal on screen. */
  shown: { machineId: string; agentId: string } | null
  /** The dive's last step, under way. */
  opening: { machineId: string; agentId: string } | null
  /** The last open's failure, until the next open or close. */
  failed: { machineId: string; agentId: string; code: EmbedErrorCode } | null
}

export interface EmbedPool {
  /**
   * The element the frame layer lives in: the stage host, which always covers the
   * viewport. Set once, before the first prewarm or open; a frame never moves to
   * another host (moving an iframe reloads it).
   */
  host(el: HTMLElement): void
  /** Start that machine's companion document hidden, on hover intent or level entry. */
  prewarm(machineId: string): void
  /**
   * Hover intent on an agent (the summary's dwell) whose machine's document is up:
   * fetch its detail ahead, so the dive skips that round trip. Mounts nothing and
   * moves no focus; at most one in flight per document, the latest wins.
   */
  prefetch(path: Required<StrataPath>): void
  /** Show the agent's terminal on the stage; rejects with the embed's error code. */
  open(path: Required<StrataPath>, attachmentId?: string): Promise<void>
  close(): void
  state(): EmbedState
  /**
   * Changes in state(), outside React. Whatever only moves or fades (the top bar,
   * the "Opening…" line) listens here. React selects only what it draws: the
   * fallback level selects failed, so opening and shown never commit.
   */
  subscribe(listener: () => void): () => void
}
