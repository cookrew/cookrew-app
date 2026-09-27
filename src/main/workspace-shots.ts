import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * A PICTURE OF EACH WORKSPACE'S CANVAS — the only thing the screen wall draws.
 *
 * The wall shows every workspace as a tilted screen carrying its canvas, and
 * the reason that is affordable at all is that none of them is REAL: a wall of
 * live canvases is N ReactFlow instances mounted at once, which is the version
 * of this feature that makes the app worse. Each screen is one JPEG.
 *
 * TAKEN AT THE MOMENT A WORKSPACE STOPS BEING LOOKED AT, which is when the
 * wall opens — the canvas is still on screen, still current, and the person is
 * by definition on their way somewhere else. Never on a timer: a capture is a
 * frame of the compositor and a write to disk, and doing that every few
 * seconds for a picture nobody has asked to see is exactly the kind of cost
 * this design is trying not to pay.
 *
 * SMALL ON PURPOSE. The wall never draws a screen wider than ~430 CSS px, so
 * the picture is capped at twice that. A full-resolution PNG per workspace is
 * the trap: several megabytes each, to be scaled down before anyone sees them.
 *
 * ITS AGE TRAVELS WITH IT. A snapshot is stale the instant it is taken, and
 * the wall stamps how stale. A picture of forty minutes ago presented as now
 * is the one way this feature could lie to somebody about their own machine.
 */

/** Twice the widest the wall ever draws a screen. */
export const SHOT_MAX_WIDTH = 860
/** JPEG, not PNG: a canvas screenshot is photographic enough that PNG is pure waste. */
export const SHOT_QUALITY = 78

export interface ShotRect {
  x: number
  y: number
  width: number
  height: number
}

/** What one workspace's picture is, as the renderer receives it. */
export interface WorkspaceShot {
  /** A data URL, ready for an <img>. */
  src: string
  /** When it was taken, epoch ms. */
  at: number
}

/**
 * The window, as this module needs it. Injected rather than imported so the
 * store can be tested without Electron — the capture is the only part that
 * needs a real window, and it is one call.
 */
export interface Capturer {
  capture(rect: ShotRect): Promise<{ resize(options: { width: number }): { toJPEG(quality: number): Buffer } }>
}

const UUID_ISH = /^[A-Za-z0-9_-]{1,64}$/

export class WorkspaceShots {
  private readonly dir: string
  private readonly now: () => number

  constructor(deps: { capturer: Capturer | null; base?: string; now?: () => number }) {
    this.capturer = deps.capturer
    this.dir = path.join(deps.base ?? path.join(homedir(), '.cookrew'), 'workspace-shots')
    this.now = deps.now ?? ((): number => Date.now())
  }

  private readonly capturer: Capturer | null

  /**
   * Where one workspace's picture lives.
   *
   * The id is checked rather than trusted: it arrives over IPC and is about to
   * become a path. A workspace id is a short token; anything else is refused
   * instead of being joined onto a directory.
   */
  fileFor(id: string): string | null {
    return UUID_ISH.test(id) ? path.join(this.dir, `${id}.jpg`) : null
  }

  /**
   * Take one. Answers false rather than throwing: this runs while somebody is
   * opening a switcher, and a capture that fails must cost them nothing more
   * than a screen with no picture on it.
   */
  async capture(id: string, rect: ShotRect): Promise<boolean> {
    const file = this.fileFor(id)
    if (file === null || this.capturer === null) return false
    if (rect.width < 1 || rect.height < 1) return false
    try {
      const image = await this.capturer.capture({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
      const width = Math.min(SHOT_MAX_WIDTH, Math.round(rect.width))
      const jpeg = image.resize({ width }).toJPEG(SHOT_QUALITY)
      if (jpeg.length === 0) return false
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(file, jpeg)
      return true
    } catch {
      // A window that went away, a rect off-screen, a full disk. The wall
      // draws an empty screen for this workspace and everything else stands.
      return false
    }
  }

  /**
   * Every picture on disk, as data URLs.
   *
   * READ WHEN THE WALL OPENS, never held. Keeping a few hundred kilobytes of
   * base64 per workspace alive for the whole session, to be looked at for two
   * seconds, is the memory version of the mistake this whole design avoids.
   */
  all(): Record<string, WorkspaceShot> {
    const out: Record<string, WorkspaceShot> = {}
    if (!existsSync(this.dir)) return out
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return out
    }
    for (const name of names) {
      if (!name.endsWith('.jpg')) continue
      const id = name.slice(0, -4)
      if (!UUID_ISH.test(id)) continue
      const file = path.join(this.dir, name)
      try {
        const bytes = readFileSync(file)
        if (bytes.length === 0) continue
        out[id] = {
          src: `data:image/jpeg;base64,${bytes.toString('base64')}`,
          at: statSync(file).mtimeMs,
        }
      } catch {
        // One unreadable file is one screen without a picture, not a wall
        // that fails to open.
      }
    }
    return out
  }

  /** A workspace that is gone should not keep a picture of itself. */
  forget(id: string): void {
    const file = this.fileFor(id)
    if (file === null) return
    try {
      rmSync(file, { force: true })
    } catch {
      // Nothing to do; the next sweep gets it.
    }
  }

  /**
   * Drop pictures of workspaces that no longer exist.
   *
   * `forget` covers the removals this process sees. This covers the ones it
   * did not — a store edited by another instance, a workspace removed before
   * this feature existed — so the directory cannot grow without a ceiling.
   */
  sweep(live: readonly string[]): number {
    const keep = new Set(live)
    let dropped = 0
    if (!existsSync(this.dir)) return 0
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.jpg')) continue
        if (keep.has(name.slice(0, -4))) continue
        rmSync(path.join(this.dir, name), { force: true })
        dropped += 1
      }
    } catch {
      // Best effort by design.
    }
    return dropped
  }

  /** For the log line, and for a test that wants to know a write happened. */
  takenAt(id: string): number | null {
    const file = this.fileFor(id)
    if (file === null || !existsSync(file)) return null
    try {
      return statSync(file).mtimeMs
    } catch {
      return null
    }
  }

  /** Unused today; kept honest so `now` is not a dead dependency. */
  ageOf(id: string): number | null {
    const at = this.takenAt(id)
    return at === null ? null : Math.max(0, this.now() - at)
  }
}
