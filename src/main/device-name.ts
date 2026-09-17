import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { deviceDisplayName } from '../shared/device-name'

/**
 * THE TWO FACTS THE NAME IS MADE OF, read from this machine.
 *
 * `hw.model` is asked of sysctl once, at boot, and a machine that will not
 * say (a Linux box, a locked-down build) is simply a "Mac" — the host still
 * tells it apart. Nothing here throws: a device name is not a reason not to
 * start.
 */
export function localModel(): string {
  try {
    return execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 2_000 }).trim()
  } catch {
    return ''
  }
}

/** "<model> · <host>", deduplicated against the names already on the account. */
export function localDeviceName(taken: readonly string[] = []): string {
  return deviceDisplayName({ model: localModel(), host: hostname(), taken })
}
