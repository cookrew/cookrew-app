// Where the attachments go after a dive. The terminal's rect is the
// companion's own (the whole stage, as the remote full view pins it) and the
// rails NEVER take from it: the rect resizes the PTY for every viewer of that
// agent. Rails only open in space the terminal leaves free; with none free
// they fold to edge tabs that open a drawer OVER the terminal, and on a phone
// to one tab that opens a bottom sheet.

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export const RAIL_MIN_WIDTH = 200
export const RAIL_MAX_WIDTH = 320
export const PHONE_MAX_WIDTH = 700

export type RailLayout =
  | { mode: 'rails'; left: Box | null; right: Box | null }
  | { mode: 'tabs' }
  | { mode: 'sheet' }

export function railLayout(viewport: { width: number; height: number }, terminal: Box): RailLayout {
  if (viewport.width <= PHONE_MAX_WIDTH) return { mode: 'sheet' }
  const leftFree = terminal.x
  const rightFree = viewport.width - (terminal.x + terminal.width)
  const column = (x: number, free: number): Box | null =>
    free >= RAIL_MIN_WIDTH ? { x, y: terminal.y, width: Math.min(free, RAIL_MAX_WIDTH), height: terminal.height } : null
  const left = column(Math.max(0, leftFree - RAIL_MAX_WIDTH), leftFree)
  const right = column(terminal.x + terminal.width, rightFree)
  return left || right ? { mode: 'rails', left, right } : { mode: 'tabs' }
}
