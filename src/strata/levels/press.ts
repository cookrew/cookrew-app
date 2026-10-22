// WHAT A PRESS ON AN AVATAR DOES. Pure, so the pick rule is tested without a DOM.

export type Press = 'none' | 'pick' | 'dive'

/**
 * held: the press was a hold, which has already shown the card.
 * pick: the level picks first (its seats are under the target); picked: this
 * seat is the one a first tap picked. A seat the level merely entered on is
 * highlighted but not picked, so it picks first like any other.
 * keyboard: Enter or Space (a click with no detail), which always dives.
 */
export const pressOf = (p: { held: boolean; pick: boolean; picked: boolean; keyboard: boolean }): Press =>
  p.held ? 'none' : p.pick && !p.picked && !p.keyboard ? 'pick' : 'dive'
