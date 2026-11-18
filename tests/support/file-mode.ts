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

/** Executable by owner, group and other: the same claim, the same caveat. */
export function expectExecutable(file: string): void {
  if (!HAS_POSIX_MODES) return
  expect(statSync(file).mode & 0o111).toBe(0o111)
}

/**
 * Why a test that LOCKS a path with chmod does not run on Windows: chmod there
 * only toggles the read-only flag, so a folder chmod 000 still lists, a file
 * 0644 still runs, and a read-only folder still takes new files. The refusal
 * such a test stages never happens, and there is no execute bit to withhold.
 */
export const CHMOD_CANNOT_LOCK = !HAS_POSIX_MODES
