import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { deviceDisplayName } from '../shared/device-name'

/**
 * THE TWO FACTS THE NAME IS MADE OF, read from this machine.
 *
 * `hw.model` is asked of sysctl once, at boot, and only on a Mac: on a BSD the
 * same key answers with a CPU. A machine with no model is named for its
 * platform (shared/device-name.ts), and the host still tells it apart. Nothing
 * here throws: a device name is not a reason not to start.
 */
export function localModel(platform: string = process.platform): string {
  if (platform !== 'darwin') return ''
  try {
    return execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 2_000 }).trim()
  } catch {
    return ''
  }
}

/** "<model> · <host>", deduplicated against the names already on the account. */
export function localDeviceName(taken: readonly string[] = [], platform: string = process.platform): string {
  return deviceDisplayName({ model: localModel(platform), host: hostname(), taken, platform })
}
