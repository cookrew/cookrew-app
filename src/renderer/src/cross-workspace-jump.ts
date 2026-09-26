/**
 * A BOARD ROW THAT LIVES SOMEWHERE ELSE — the travel between the tap and the
 * card.
 *
 * The board is the one surface that shows the WHOLE machine: every agent in
 * every workspace, ninety of them across three canvases. A tap on a row has
 * always meant "take me to that card", and for a row on the loaded canvas it
 * is one `zoomToNode`. For every other row it was silence. The card is not in
 * the flow store, so the zoom resolved no bounds, reported the miss to the
 * console (nodes/zoom-target.ts) and left the viewport exactly where it was —
 * while the board closed itself on the way out. The owner tapped Conductor in
 * GOAT TEAM and was handed back the COOKREW DEV canvas with no explanation.
 *
 * The missing middle is a workspace switch, and a switch is not something a
 * tap can await: main persists the outgoing canvas, boots the incoming PTYs
 * and then broadcasts — the new `activeId` first, the new nodes after (see
 * store.switchWorkspace). So the tap leaves a STANDING INTENT behind it, and
 * this is that intent: who we are going to, which card we owe them, and what
 * to do when the canvas that arrives is not the one we asked for.
 *
 * Pure of React and of the flow store on purpose. Everything that can go wrong
 * here goes wrong in the ordering — a canvas arriving without the card, a
 * second tap mid-flight, a switch the app refuses, a workspace that never
 * answers — and none of that is worth a browser to test.
 */

/** The only thing this module needs to know about a card. */
export interface JumpNode {
  readonly id: string
}

/** Why a tap went nowhere. Never silent: the silence WAS the defect. */
export interface JumpMiss {
  readonly workspaceId: string
  readonly nodeId: string
  /** `refused` — the switch itself failed. `never-arrived` — the wait ran out. */
  readonly why: 'refused' | 'never-arrived'
}

export interface JumpDeps<N extends JumpNode> {
  /** The canvas on screen right now, or null before the first list lands. */
  readonly activeWorkspaceId: () => string | null
  /**
   * Is this card on the canvas already? The flow store is the truth and the
   * row's workspace id is only a claim, made whenever its roster was read.
   */
  readonly hasNode: (nodeId: string) => boolean
  readonly switchWorkspace: (workspaceId: string) => Promise<unknown>
  /**
   * Fly the viewport to the card. The node comes with it when the jump landed
   * on a canvas we were handed — that spares the caller a lookup against a
   * flow store that has only just been given these nodes. Null means the card
   * was here all along and the caller already knows where to find it.
   */
  readonly arrive: (nodeId: string, node: N | null) => void
  /**
   * Frame the whole board — what a switch does for itself when nobody asked
   * for a particular card. A jump BORROWS this fit (its own card is a better
   * destination) and hands it back if the card never shows up.
   */
  readonly frameAll: () => void
  /** Arm the give-up timer; returns its canceller. `window.setTimeout`, in App. */
  readonly schedule: (run: () => void, ms: number) => () => void
  readonly report?: (miss: JumpMiss) => void
  readonly waitMs?: number
}

export interface JumpController<N extends JumpNode> {
  /** A board row was tapped: go to that card, wherever it lives. */
  readonly to: (workspaceId: string, nodeId: string) => void
  /** A canvas arrived. Lands the jump if this is the one it was waiting for. */
  readonly sawNodes: (nodes: readonly N[]) => void
  /** True between the switch and the landing — the jump owns the viewport. */
  readonly travelling: () => boolean
  /** Drop a jump in flight (unmount): nothing may zoom after this. */
  readonly cancel: () => void
}

/**
 * How long a jump waits for its card before giving the viewport back.
 *
 * A switch tears down the outgoing PTYs and boots the incoming ones before it
 * broadcasts, and a sixteen-terminal workspace has been measured in seconds,
 * not milliseconds (the switch-runner exists because that once blocked the
 * main thread for ~90s). So this is generous on purpose: giving up early would
 * frame the board over a card that was about to arrive, which is a worse
 * failure than waiting a beat too long.
 */
export const JUMP_WAIT_MS = 12_000

interface Pending {
  readonly workspaceId: string
  readonly nodeId: string
}

export function createJumpController<N extends JumpNode>(deps: JumpDeps<N>): JumpController<N> {
  const waitMs = deps.waitMs ?? JUMP_WAIT_MS
  let pending: Pending | null = null
  let disarm: (() => void) | null = null

  /** Forget the jump and its timer. The ONE way the intent ends. */
  const settle = (): void => {
    pending = null
    disarm?.()
    disarm = null
  }

  const miss = (target: Pending, why: JumpMiss['why']): void => {
    deps.report?.({ workspaceId: target.workspaceId, nodeId: target.nodeId, why })
  }

  const to = (workspaceId: string, nodeId: string): void => {
    // Already waiting for exactly this card: a second tap is impatience, not a
    // new instruction. Re-arming would push the deadline out every time the
    // owner taps again, which is the opposite of what they are asking for.
    if (pending?.nodeId === nodeId && pending.workspaceId === workspaceId) return
    settle()
    const active = deps.activeWorkspaceId()
    // Null means the first workspace list has not landed yet, so there is no
    // id to compare against. Zoom — that is what every row did before this
    // existed, a card that is here opens, and one that is not reports its own
    // miss. Guessing at a switch on no evidence could yank the owner off the
    // canvas they are looking at.
    //
    // And a card that is DEMONSTRABLY here is here, whatever the row says: a
    // roster can be a switch behind, and the demo bridge labels every row
    // `active` because it builds them from the loaded canvas. Switching on a
    // claim the canvas contradicts is a round trip to the same place at best,
    // and at worst a refusal where a zoom was owed.
    if (active === null || active === workspaceId || deps.hasNode(nodeId)) {
      deps.arrive(nodeId, null)
      return
    }
    const target: Pending = { workspaceId, nodeId }
    pending = target
    disarm = deps.schedule(() => {
      // Only ours: `settle` disarms, so reaching here means this jump is still
      // the standing one.
      settle()
      miss(target, 'never-arrived')
      deps.frameAll()
    }, waitMs)
    void deps.switchWorkspace(workspaceId).catch(() => {
      // The workspace is gone, or main refused. Nothing moved and nothing is
      // going to, so end the intent rather than let it sit until the timer
      // frames a canvas the owner never left.
      if (pending !== target) return
      settle()
      miss(target, 'refused')
    })
  }

  const sawNodes = (nodes: readonly N[]): void => {
    const target = pending
    if (target === null) return
    const landed = nodes.find((node) => node.id === target.nodeId)
    if (landed === undefined) return
    settle()
    deps.arrive(target.nodeId, landed)
  }

  return {
    to,
    sawNodes,
    travelling: () => pending !== null,
    cancel: settle
  }
}

/** Cards already reported — a tap that goes nowhere must say so once, not on
 *  every retry. */
const reported = new Set<string>()

/**
 * Say, ONCE per card, that a jump never landed.
 *
 * The impure export in an otherwise pure module, for the same reason
 * zoom-target.ts has one: the failure this whole file exists to fix was
 * invisible precisely because the failing path printed nothing, so the saying
 * belongs beside the deciding rather than at a call site that can forget it.
 */
export function reportJumpMiss(miss: JumpMiss): void {
  if (reported.has(miss.nodeId)) return
  reported.add(miss.nodeId)
  const why =
    miss.why === 'refused'
      ? `the switch to workspace ${miss.workspaceId} was refused`
      : `workspace ${miss.workspaceId} did not deliver the card within ${JUMP_WAIT_MS}ms`
  console.warn(
    `Cookrew: a board row asked for card ${miss.nodeId} and ${why}. ` +
      'The canvas was framed where it landed.'
  )
}

/** Test seam: forget what has been reported. */
export function resetJumpMisses(): void {
  reported.clear()
}
