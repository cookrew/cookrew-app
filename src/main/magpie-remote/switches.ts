import type { LiveValues } from '../../shared/launch-settings'

/**
 * Magpie AND Magpie remote, read now. A reader that throws or answers null is off:
 * every sealed request, key and connect asks this, and none of them fails open.
 */
export function remoteSwitchedOn(read: () => LiveValues | null | undefined): boolean {
  try {
    const values = read()
    return values?.magpie === true && values.magpieRemote === true
  } catch {
    return false
  }
}
