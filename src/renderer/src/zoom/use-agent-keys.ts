import { useEffect, useRef } from 'react'
import { groupIndexOf, keyMove, nearestToward, ownsKey, pickKey, ringOf, samePick, spotAt, stepRing, type KeyMove, type PickGroup, type PickSpot } from './agent-keys'

/**
 * THE KEYS ON THE PAGE (agent-keys.ts decides; this reads the page). At the
 * devices stop the faces are DevicesAgents' (`.da-face[data-pick]`), a row up or
 * down within the machine's screen; at the workspaces stop they are the tiles'
 * (WorkspaceTile.tsx), a row up or down being the tile above or below.
 */

export type KeysStop = 'devices' | 'workspaces'

/** The popped card's reply box: a floating card's (QuickReply, RemotePickCard) or a workspace card's. */
export const REPLY_BOX = '.zv-pick-card .zv-reply input, .dm-ov-layer .zv-reply input'

/** What holds the focus: the page, the popped card's reply box, or something that keeps its own keys. */
export function focusPlace(target: EventTarget | null): 'page' | 'box' | 'elsewhere' {
  const el = target !== null && typeof (target as Element).closest === 'function' ? (target as Element) : null
  if (!el || (typeof document !== 'undefined' && (el === document.body || el === document.documentElement))) return 'page'
  // The reply box only: a card's name field (NameEdit.tsx) keeps its own Tab and arrows.
  if (el.closest(REPLY_BOX)) return 'box'
  if (el.closest('input, textarea, select, [contenteditable="true"], .xterm, .cmd, .cr-board-search, .cr-board-pop, .cr-prompt, [role="menu"], [role="listbox"], .zv-bar-card')) return 'elsewhere'
  const dialog = el.closest('[role="dialog"]')
  if (dialog && !dialog.classList.contains('zv-pick-card')) return 'elsewhere'
  return 'page'
}

const centre = (el: Element): { x: number; y: number } => {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

const faceOf = (root: ParentNode, spot: PickSpot): HTMLElement | null => root.querySelector<HTMLElement>(`[data-pick="${CSS.escape(pickKey(spot))}"]`)

/** Where a move goes from `at`: along the ring, or to the nearest row up or down. */
function moveFrom(stop: KeysStop, move: KeyMove, groups: readonly PickGroup[], at: PickSpot | null, root: HTMLElement | null): PickSpot | null {
  const ring = ringOf(groups)
  const here = at && ring.some((s) => samePick(s, at)) ? at : null
  if (move === 'next' || move === 'prev' || !here) return stepRing(ring, here, move === 'prev' || move === 'up' ? -1 : 1)
  if (!root) return null
  if (stop === 'devices') {
    // Up and down stay on the machine's own screen.
    const face = faceOf(root, here)
    const screen = face?.closest('.da-screen')
    if (!face || !screen) return null
    const spots = [...screen.querySelectorAll<HTMLElement>('.da-face[data-pick]')].map((el) => ({ key: el.dataset.pick ?? '', ...centre(el) }))
    const key = nearestToward(centre(face), spots, move)
    return key ? (ring.find((s) => pickKey(s) === key) ?? null) : null
  }
  // A tile is a point (zv-mark): the one above or below, at the same place in its row of faces.
  const tiles = [...root.querySelectorAll<HTMLElement>('.zv-device .zv-mark[data-ws]')]
  const from = tiles.find((t) => t.dataset.ws === here.workspace)
  if (!from) return null
  const peopled = new Set(groups.filter((g) => g.machine === here.machine && g.agents.length > 0).map((g) => g.workspace))
  const spots = tiles.filter((t) => peopled.has(t.dataset.ws ?? '')).map((t) => ({ key: t.dataset.ws ?? '', ...centre(t) }))
  const ws = nearestToward(centre(from), spots, move)
  return ws ? spotAt(groups, here.machine, ws, groupIndexOf(groups, here)) : null
}

/** Scroll `el` into its scroller's view, the scroller drawn at any scale. */
export function revealIn(scroller: HTMLElement, el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  const k = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1
  const pad = 10 * k
  if (r.top < box.top + pad) scroller.scrollTop -= (box.top + pad - r.top) / k
  else if (r.bottom > box.bottom - pad) scroller.scrollTop += (r.bottom - (box.bottom - pad)) / k
}

export interface AgentKeys {
  /** Where the keys work now: a stop at rest, none in a full view or another machine. */
  stop: () => KeysStop | null
  /** That stop's agents, workspace by workspace, in drawn order. */
  groups: (stop: KeysStop) => readonly PickGroup[]
  picked: () => PickSpot | null
  pick: (spot: PickSpot) => void
  root: () => HTMLElement | null
}

/** Tab, Shift-Tab and the arrows, agent by agent, while the stop is at rest (capture: before the page's own). */
export function useAgentKeys(keys: AgentKeys): void {
  const now = useRef(keys)
  now.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const move = keyMove(e)
      if (!move) return
      const k = now.current
      const stop = k.stop()
      if (!stop || document.querySelector('[aria-modal="true"]')) return
      const field = e.target instanceof HTMLInputElement ? e.target : null
      if (!ownsKey(focusPlace(e.target), move, { empty: !field || field.value === '', tab: e.key === 'Tab' })) return
      const groups = k.groups(stop)
      if (!groups.some((g) => g.agents.length > 0)) return
      // The key is ours, gone somewhere or not: Tab never wanders off into the bar, an arrow never scrolls the page.
      e.preventDefault()
      e.stopPropagation()
      const next = moveFrom(stop, move, groups, k.picked(), k.root())
      if (next) k.pick(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

/** The popped card's reply box, once it is there and shown: the keys put the caret in it. */
export function focusPickBox(scope: ParentNode, selector: string): () => void {
  let frames = 0
  let raf = 0
  const give = (): void => {
    const input = scope.querySelector<HTMLInputElement>(selector)
    if (input && !input.disabled) input.focus({ preventScroll: true })
    if (input && document.activeElement === input) return
    if (++frames < 30) raf = requestAnimationFrame(give)
  }
  raf = requestAnimationFrame(give)
  return () => cancelAnimationFrame(raf)
}
