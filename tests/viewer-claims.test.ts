// ONLY A VIEWER SOMEONE OPENED TAKES A SHARED PANE'S SIZE (owner, 2026-10-31:
// "the phone's and the desktop's transcripts interfere"). The desktop's stage
// mounts terminals on its own; every mount counted as use, fitted the pane to
// the desktop and nudged it, while the owner read on the phone.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const overlay = readFileSync(path.join(__dirname, '..', 'src/renderer/src', 'TerminalOverlay.tsx'), 'utf8')

describe('a terminal that mounts', () => {
  it('counts as used only when someone clicked, tapped or typed in the window just before', () => {
    expect(overlay).toContain('createSizeOwner(openedAt(Date.now(), lastUserInputAt()))')
  })

  it('fits and sends its size only when it owns it', () => {
    const fit = overlay.slice(overlay.indexOf('const fitUntilStable'), overlay.indexOf('fitUntilStable()\n'))
    expect(fit).toContain('if (disposed || !owns()) return')
  })

  it('nudges the shared pane, on mount or reconnect, only when it owns the size', () => {
    expect(overlay).toMatch(/kickTimer = setTimeout\(\(\) => \{\s*kickTimer = null\s*if \(owns\(\)\) repaintKick\(\)/)
    expect(overlay).toContain('if (helloSeen && owns() && Date.now() - lastKickAt > 2000)')
  })
})

describe('the window starts listening for clicks at app start', () => {
  it('so the click that opens the first terminal after a load counts', () => {
    const main = readFileSync(path.join(__dirname, '..', 'src/renderer/src', 'main.tsx'), 'utf8')
    const at = main.indexOf('watchUserInput()\n')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(main.indexOf('ReactDOM.createRoot('))
  })
})

describe('the mount kick runs once, when the box has settled', () => {
  it('waits for the box to be still, and every box change while opening moves it', () => {
    expect(overlay).toContain('}, MOUNT_KICK_SETTLE_MS)')
    expect(overlay).toContain('if (kickTimer !== null && Date.now() - mountedAt < MOUNT_SETTLE_WINDOW_MS) scheduleMountKick()')
  })
})

