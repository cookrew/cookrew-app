import { appendedPath } from './launch-defaults'

export { installerDirs } from './launch-defaults'

/**
 * THE PATH A PANE GETS, AND THE ONE THE TOOL CHECK TRUSTS: the same function,
 * so Found means an agent can start (round 2, bug 3: the check read the login
 * shell, panes read the app, and a Found tool died at exec on a source build).
 *
 * This is apart from process.env.PATH on purpose. That one chooses the terminal
 * host when PtyManager is built, and a QA instance's PATH without herdr is what
 * keeps it off the fleet's host (memory: second-instance-kills-fleet). A dir
 * added here reaches a pane and never the host probe.
 */

let added: readonly string[] = []

/** A dir lands inside a single-quoted `export PATH='...'`, so only a plain absolute one is taken. */
const usable = (dir: string): boolean => dir.startsWith('/') && !/[':\r\n\0]/.test(dir)

export function addPaneDirs(dirs: readonly string[]): void {
  added = [...new Set([...added, ...dirs.filter(usable)])]
}

export function paneDirs(): readonly string[] {
  return added
}

export function panePath(base: string | undefined = process.env.PATH): string {
  return appendedPath(base, added)
}

/** Tests only: this is module state, as the PATH it stands beside is. */
export function resetPaneDirs(): void {
  added = []
}
