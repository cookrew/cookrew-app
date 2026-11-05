// THE DESKTOP'S DISPLAY, in points: the zoom draws this machine's screen at
// its proportions (src/shared/levels.ts · MachineDisplay). A laptop's own panel
// when it has one, so a Mac at a monitor still draws as the Mac; else the
// primary display.

import type { MachineDisplay } from '../shared/levels'

interface DisplayLike {
  internal?: boolean
  size: { width: number; height: number }
}

interface ScreenLike {
  getAllDisplays: () => DisplayLike[]
  getPrimaryDisplay: () => DisplayLike
}

/** Pure: the display the machine is drawn with, or null when there is none to read. */
export function pickMachineDisplay(all: readonly DisplayLike[], primary: DisplayLike | null): MachineDisplay | null {
  const chosen = all.find((d) => d.internal) ?? primary ?? all[0] ?? null
  if (!chosen || !(chosen.size.width > 0) || !(chosen.size.height > 0)) return null
  return { w: Math.round(chosen.size.width), h: Math.round(chosen.size.height) }
}

/**
 * Electron's screen, asked on each read (displays come and go); null when it
 * cannot answer: before the app is ready, or where electron is mocked without it.
 */
export function readMachineDisplay(screenOf: () => ScreenLike | undefined): MachineDisplay | null {
  try {
    const screen = screenOf()
    return screen ? pickMachineDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay()) : null
  } catch (error) {
    console.error('Cannot read the display:', error)
    return null
  }
}
