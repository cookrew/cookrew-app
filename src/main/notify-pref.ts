import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'

/**
 * Notifications on or off, this desktop's (notifier.ts). Kept by main in its
 * own file, so the switch holds from the first moment of a launch, before any
 * window has said anything. On until the owner turns it off; a file that
 * cannot be read is the default, and is left as it is.
 */
const FILE = 'notifications.json'

export function readNotifyPref(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && (parsed as { enabled?: unknown }).enabled === false) return false
    return true
  } catch {
    return true
  }
}

export function writeNotifyPref(dir: string, enabled: boolean): void {
  writeFileAtomic(path.join(dir, FILE), `${JSON.stringify({ enabled })}\n`)
}
