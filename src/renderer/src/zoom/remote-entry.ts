/**
 * ANOTHER MACHINE IS ENTERED IN PLACE (0.6.0). Its view (RemoteMachineView.tsx)
 * grows out of its own frame on the devices stop: the first thing drawn is the
 * whole view squeezed into where that frame stands, and it opens from there.
 * Pure: the two boxes in, the first frame's transform out.
 */
export interface ScreenBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const f = (n: number): string => String(Math.round(n * 1000) / 1000)

/** The transform that draws `stage` where `from` stands, or null when there is nothing to grow from. */
export function entryFrom(from: ScreenBox, stage: ScreenBox): { transform: string; origin: string } | null {
  const real = [from.x, from.y, from.w, from.h, stage.x, stage.y, stage.w, stage.h].every(Number.isFinite)
  if (!real || from.w <= 0 || from.h <= 0 || stage.w <= 0 || stage.h <= 0) return null
  return { transform: `translate(${f(from.x - stage.x)}px, ${f(from.y - stage.y)}px) scale(${f(from.w / stage.w)}, ${f(from.h / stage.h)})`, origin: '0 0' }
}

/** How long the opening takes. Short: it says where the view came from, it is not a show. */
export const ENTRY_MS = 240
