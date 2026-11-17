export const HEAVY_SLOT_DIR: string
export const TEST_NICE: number
export const MAX_WORKER_HEAP_MB: number
export const WORKER_GUARD: { setupFiles: string[]; execArgv: string[] }
export function isWholeSuiteRun(args: readonly string[], isTTY?: boolean): boolean
export function slotCount(raw: string | undefined): number
export function testWorkers(env?: NodeJS.ProcessEnv, machine?: { cores?: number; load?: number }): number
export function yieldToAgents(
  env?: NodeJS.ProcessEnv,
  priority?: { get?: () => number; set?: (priority: number) => void }
): boolean
export function liveSlots(dir: string, options?: { isAlive?: (pid: number) => boolean; now?: number }): string[]
export function takeHeavySlot(options?: {
  dir?: string
  slots?: number
  pid?: number
  isAlive?: (pid: number) => boolean
  maxWaitMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onWait?: (held: number) => void
}): Promise<{ taken: boolean; waitedMs: number }>
export function awaitTestSlot(args?: readonly string[], env?: NodeJS.ProcessEnv): Promise<void>
