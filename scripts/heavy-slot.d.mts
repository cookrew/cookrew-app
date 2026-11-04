export const HEAVY_SLOT_DIR: string
export function isWholeSuiteRun(args: readonly string[], isTTY?: boolean): boolean
export function slotCount(raw: string | undefined): number
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
