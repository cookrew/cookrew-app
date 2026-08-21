import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './turn-annotations'
import { nextVersion, type VersionPinRecord } from '../shared/version-pin'

/**
 * VERSION PINS ON DISK (§10) — one file per terminal, `~/.cookrew/pins/<id>.json`.
 *
 * This closes the M1 deferral. Until now `planPresetImport` cut a pin and the
 * caller dropped it, so §10 was answerable on paper and unanswerable at runtime:
 * the contract shipped, the marker was built against it, and nothing anywhere
 * held a pin for either to describe.
 *
 * A pin is permanent, named and addressable, which is exactly why it lives
 * beside the workspace rather than inside it: a pin outlives the card it
 * describes, and a version the buyer holds must not disappear because a
 * terminal was closed.
 */

const PINS_DIR = 'pins'
/** Terminal ids are UUIDs. Validated because this value becomes a path. */
const TERMINAL_ID = /^[0-9a-fA-F-]{36}$/

export function isTerminalId(value: string): boolean {
  return typeof value === 'string' && TERMINAL_ID.test(value)
}

export class PinStore {
  private readonly root: string

  constructor(base: string = path.join(homedir(), '.cookrew')) {
    this.root = path.join(base, PINS_DIR)
  }

  /**
   * The file for a terminal, or null. Same discipline as the preset store: a
   * value from the renderer becomes a path only after it is proven to be an
   * id, and the resolved path is asserted to stay inside the store.
   */
  private fileFor(terminalId: string): string | null {
    if (!isTerminalId(terminalId)) return null
    const file = path.resolve(path.join(this.root, `${terminalId}.json`))
    const root = path.resolve(this.root)
    if (!file.startsWith(root + path.sep)) return null
    return file
  }

  /** Pins for a terminal, oldest version first. Empty when there are none. */
  list(terminalId: string): VersionPinRecord[] {
    const file = this.fileFor(terminalId)
    if (file === null || !existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as VersionPinRecord[]
      if (!Array.isArray(parsed)) return []
      // A malformed record is dropped rather than rendered: the rail would
      // place it somewhere, and a pin in the wrong place is a wrong version.
      return parsed
        .filter(
          (p) =>
            Number.isInteger(p?.version) &&
            Number.isInteger(p?.atIndex) &&
            Number.isInteger(p?.scrollLine)
        )
        .sort((a, b) => a.version - b.version)
    } catch {
      return []
    }
  }

  /**
   * Record a pin. Idempotent by version: re-recording a version already held
   * is a no-op rather than a duplicate, so a retried install cannot make one
   * version appear twice on the rail.
   */
  add(terminalId: string, pin: VersionPinRecord): void {
    const file = this.fileFor(terminalId)
    if (file === null) throw new Error('refusing to record a pin against a non-id')
    const existing = this.list(terminalId)
    if (existing.some((p) => p.version === pin.version)) return
    mkdirSync(this.root, { recursive: true })
    writeFileAtomic(file, JSON.stringify([...existing, pin], null, 2))
  }

  /** The version a new cut against this terminal would take. */
  next(terminalId: string): number {
    return nextVersion(this.list(terminalId))
  }
}
