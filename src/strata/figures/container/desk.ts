// The standard table's measures, in model units (colorfigures axes: x = depth
// toward viewer-right, y = width toward viewer-left, z = up). Every workspace
// is this table, one to four modules long: seats, props, plaque and tray are
// all placed from these numbers, so nothing about the form is per workspace.
import { MODULE } from './layout'

/** Row to row (x) and seat to seat along a row (y). */
export const PITCH_X = 10
export const PITCH_Y = 8.4
/** y margin at each end of the table. */
export const SIDE = 2.4
/** x from the back edge to the first row: the back panel and the strip its props stand on. */
export const BACK = 5.4
export const FRONT = 2
export const DEPTH = BACK + MODULE.rows * PITCH_X + FRONT
/** Height of the table top, and its thickness. */
export const TOP = 13
export const SLAB = 2.4
/** The back panel: its face is at x = PANEL, it rises HUTCH above the top, a rail caps it. */
export const PANEL = 1.6
export const HUTCH = 12
export const CAP = 0.8
/** Where standing props go: between the panel and the first row. */
export const STRIP = { x0: PANEL + 0.3, x1: BACK - 0.6 } as const
/** The front apron under the top, which carries the name plaque. */
export const APRON = { z0: 6.4, z1: TOP - SLAB } as const
export const MODULE_W = MODULE.cols * PITCH_Y

export const tableWidth = (modules: number): number => 2 * SIDE + modules * MODULE_W
/** Where module k starts along y. */
export const moduleY = (k: number): number => SIDE + k * MODULE_W
