/**
 * WHERE THE STAGE ENDS FOR WHAT STANDS ON IT (owner, 2026-11-03). On a phone
 * the prompt box floats over the stage's foot (prompt/global-prompt.css · THE
 * BOX FLOATS), so the stage runs to the screen's bottom and the pill's top is
 * the real floor: the pets' bed and where a card may open stop there. Under a
 * dock that is a band (desktop), its top IS the stage's bottom, so nothing
 * changes there. Pure, so it is tested as numbers.
 */
export function stageFloor({
  stageBottom,
  dockTop,
  viewport,
  trayTop = null
}: {
  stageBottom: number
  dockTop: number | null
  viewport: number
  /** The phone's tray floats over the pill, out of the dock's box (global-prompt.css · THE TRAY FLOATS): its top, while it shows. */
  trayTop?: number | null
}): number {
  return Math.min(viewport, stageBottom, dockTop ?? stageBottom, trayTop ?? stageBottom)
}

/** What moves the floor when it changes size: the stage, the dock, and the phone's tray (it shows and hides). */
export const FLOOR_PARTS = ['.cr-stage', '.cr-dock', '.cr-dock .cr-prompt-tray'] as const

/** The floor as the page draws it now. */
export function stageFloorNow(): number {
  const stage = document.querySelector('.cr-stage')
  const dock = document.querySelector('.cr-dock')
  const dockBox = dock?.getBoundingClientRect()
  // Hidden (at rest, or a wide screen's, which has no box) it measures nothing.
  const trayBox = document.querySelector('.cr-dock .cr-prompt-tray')?.getBoundingClientRect()
  return stageFloor({
    stageBottom: stage ? stage.getBoundingClientRect().bottom : window.innerHeight,
    dockTop: dockBox && dockBox.height > 0 ? dockBox.top : null,
    viewport: window.innerHeight,
    trayTop: trayBox && trayBox.height > 0 ? trayBox.top + trayPad(trayBox) : null
  })
}

/** The tray's padding over its chips (room for their shadows): the floor is the chips' top, not the scroller's. */
function trayPad(box: DOMRect): number {
  const tray = document.querySelector('.cr-dock .cr-prompt-tray')
  const pad = tray ? Number.parseFloat(getComputedStyle(tray).paddingTop) : 0
  return Number.isFinite(pad) ? Math.min(pad, box.height) : 0
}
