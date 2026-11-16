export type Lockfile = { version?: string; packages?: Record<string, Record<string, unknown>>; [field: string]: unknown }

export function versionlessLock(lock: Lockfile): Lockfile
export function depsKey(input: {
  lock: Lockfile
  postinstall?: string
  scripts: readonly string[]
  runtime: readonly string[]
}): string
export const POSTINSTALL_SCRIPTS: readonly string[]
