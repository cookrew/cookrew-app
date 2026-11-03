/**
 * WHERE THE STAGE ENDS FOR WHAT STANDS ON IT (owner, 2026-11-03). On a phone
 * the prompt box floats over the stage's foot (prompt/global-prompt.css · THE
 * BOX FLOATS), so the stage runs to the screen's bottom and the pill's top is
 * the real floor: the pets' bed and where a card may open stop there. Under a
 * dock that is a band (desktop), its top IS the stage's bottom, so nothing
 * changes there. Pure, so it is tested as numbers.
 */
export function stageFloor({ stageBottom, dockTop, viewport }: { stageBottom: number; dockTop: number | null; viewport: number }): number {
  return Math.min(viewport, stageBottom, dockTop ?? stageBottom)
}

/** The floor as the page draws it now. */
export function stageFloorNow(): number {
  const stage = document.querySelector('.cr-stage')
  const dock = document.querySelector('.cr-dock')
  const dockBox = dock?.getBoundingClientRect()
  return stageFloor({
    stageBottom: stage ? stage.getBoundingClientRect().bottom : window.innerHeight,
    dockTop: dockBox && dockBox.height > 0 ? dockBox.top : null,
    viewport: window.innerHeight
  })
}
