import { InkAvatar } from './InkAvatar'
import type { InkStatus } from './ink-status'
import './agents-group.css'

/**
 * THE AGENTS GROUP, ONE FORM EVERYWHERE (owner, 2026-11-17: "所有的agents group统一样式",
 * after the workspace card's row): a face at an agent card's own 36 px, a gap of 6 between
 * faces (no face over another), a swipe along the row instead of "+N" pages, faces fading
 * out at the ends, and the seal with the whole count at the end. A row on the workspace
 * card (WorkspaceTile) and over the artifacts (zoom-frame.ts · the shelf); a column beside
 * a desktop's full view (pets/PetTroop.tsx · group). Its measures are plain numbers, so the
 * painter's layout (zoom-layout.ts · shelfRow) reckons with them too.
 */
export const GROUP_FACE = 36
export const GROUP_GAP = 6
export const GROUP_STEP = GROUP_FACE + GROUP_GAP
/** The gap between the last face shown and the seal. */
export const GROUP_SEAL_GAP = 8
/** What the seal takes after the last face shown: its gap and its own width. */
export const GROUP_SEAL_ROOM = 30

/** How much of a face shows `d` faces from the strip's start, `shown` faces holding it: gone a little past either end. */
export function groupFade(d: number, shown = Infinity): number {
  const past = d < 0 ? -d : d > shown - 1 ? d - (shown - 1) : 0
  return Math.max(0, Math.min(1, 1 - past * 1.4))
}

/** How many faces a strip of `room` px shows, keeping the seal's room after them. */
export const groupFits = (room: number): number => Math.max(1, Math.floor((room - GROUP_SEAL_ROOM - GROUP_FACE) / GROUP_STEP) + 1)

export function GroupFace({ id, preset, orch, status, size = GROUP_FACE }: { id: string; preset: string; orch?: boolean; status?: InkStatus; size?: number }): React.JSX.Element {
  return <InkAvatar id={id} preset={preset} orch={orch} status={status} size={size} weight="small" />
}

/** The whole count, in the seal: never "+N". */
export function GroupSeal({ count, label = 'agents' }: { count: number; label?: string }): React.JSX.Element {
  return <i className="ag-seal" title={`${count} ${label}`}>{count}</i>
}
