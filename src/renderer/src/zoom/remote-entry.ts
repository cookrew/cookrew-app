/**
 * ANOTHER MACHINE IS ENTERED IN PLACE (0.6.0). Its view (RemoteMachineView.tsx)
 * grows out of its own frame on the devices stop: the first thing drawn is the
 * view seen through a window where that frame stands, and the window opens
 * to the whole view. Pure: the two boxes in, the two clip paths out.
 */
export interface ScreenBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const px = (n: number): string => `${Math.max(0, Math.round(n))}px`

/**
 * The two ends of the opening, as clip paths on the view: first seen through a
 * window where the frame stands, then whole. CLIPPED, NOT SCALED: on a phone
 * the frame is a wide sliver of a tall view, and a view squeezed into it would
 * be four times flatter than it is. Null when there is nothing to open from.
 */
export function entryFrom(from: ScreenBox, stage: ScreenBox): { from: string; to: string } | null {
  const real = [from.x, from.y, from.w, from.h, stage.x, stage.y, stage.w, stage.h].every(Number.isFinite)
  if (!real || from.w <= 0 || from.h <= 0 || stage.w <= 0 || stage.h <= 0) return null
  const top = from.y - stage.y
  const left = from.x - stage.x
  const right = stage.x + stage.w - (from.x + from.w)
  const bottom = stage.y + stage.h - (from.y + from.h)
  return { from: `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round 14px)`, to: 'inset(0px 0px 0px 0px round 0px)' }
}

/** How long the opening takes. Short: it says where the view came from, it is not a show. */
export const ENTRY_MS = 240
