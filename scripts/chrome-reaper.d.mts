/** Types for the orphan-Chrome reaper, for the tests and the perf scripts that import it. */
export function orphanChromePids(psOutput: string, marker: string): number[]
export function reapOrphans(
  marker: string,
  over?: { ps?: () => string; kill?: (pid: number) => void }
): number[]
export function guardChromeWithParent(options: {
  childPid: number | undefined
  parentPid?: number
  pollMs?: number
}): { stop(): void }
