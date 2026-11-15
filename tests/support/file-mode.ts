import { statSync } from 'node:fs'
import { expect } from 'vitest'

/**
 * Windows has no POSIX permission bits: `stat` reports 0o666 for every file
 * that is not read-only and `chmod` only toggles that read-only flag. So "is
 * written 0600" is a claim about POSIX hosts, and on win32 the rest of the test
 * still runs; only the bits go unasserted.
 */
export const HAS_POSIX_MODES = process.platform !== 'win32'

export function expectMode(file: string, mode: number): void {
  if (!HAS_POSIX_MODES) return
  expect(statSync(file).mode & 0o777).toBe(mode)
}
