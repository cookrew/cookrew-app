// THE MACHINE IS A BUDGET, AND THE FLEET IS WHAT SPENDS IT.
//
// Measured 2026-11-05 on the owner's 16 GB Mac, with 66 claude processes: load
// 89, 54 % of CPU in the kernel, swap 13.6 of 14.3 GB, 36 GB of footprint. Not
// a crash and not a hot loop: the machine was paging. So agent count has a
// real ceiling, and it moves with what each agent happens to hold.
//
// Free memory cannot show this (macOS keeps it near zero by design) and RSS
// hides it (a swapped agent's RSS is small). Swap against physical RAM is what
// tracks the felt stall, but swap drains for hours after a storm is over, so
// `high` also needs the kernel to still be saying warn. Half of RAM in swap is
// critical whatever the kernel says.
//
// SCOPE — the decisions are pure; readMachineMemory is the one reader.

import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { CRITICAL_SWAP_SHARE, HIGH_SWAP_SHARE, KERNEL_CRITICAL, KERNEL_WARN } from '../shared/machine-gauges'

const execFileAsync = promisify(execFile)

export type PressureLevel = 'normal' | 'high' | 'critical'

export interface MachineMemory {
  swapUsedMb: number
  physicalMb: number
  /** kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
  kernelLevel: number
}

/** Owner's ruling of 2026-11-01 was against ten minutes; both stay above it. */
const HIGH_WINDOW_MS = 30 * 60_000
const CRITICAL_WINDOW_MS = 15 * 60_000

/** `sysctl vm.swapusage` → megabytes used, null when it cannot be read. */
export function parseSwapUsedMb(text: string): number | null {
  const match = /used\s*=\s*([\d.]+)([MG])/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  return match[2] === 'G' ? value * 1024 : value
}

export function pressureOf(memory: MachineMemory): PressureLevel {
  const share = memory.swapUsedMb / memory.physicalMb
  if (memory.kernelLevel >= KERNEL_CRITICAL || share >= CRITICAL_SWAP_SHARE) return 'critical'
  return share >= HIGH_SWAP_SHARE && memory.kernelLevel >= KERNEL_WARN ? 'high' : 'normal'
}

/**
 * The idle window for this level. The evidence gate is unchanged at every
 * level, so pressure can only reach an agent that has truly been quiet.
 */
export function sleepWindowMs(level: PressureLevel, baseMs: number): number {
  if (level === 'critical') return Math.min(baseMs, CRITICAL_WINDOW_MS)
  return level === 'high' ? Math.min(baseMs, HIGH_WINDOW_MS) : baseMs
}

/**
 * Cold pane-pid lookups per sweep. Each is a synchronous herdr child, so two
 * is the gentle default; forty idle cards at two a minute is twenty minutes
 * of a stalled machine, so pressure spends more of them.
 */
export function sleepColdLookups(level: PressureLevel): number {
  if (level === 'critical') return 10
  return level === 'high' ? 5 : 2
}

async function sysctl(name: string): Promise<string> {
  const { stdout } = await execFileAsync('sysctl', ['-n', name], { timeout: 5000 })
  return stdout
}

/** Null off macOS or when sysctl fails: no reading means no pressure response. */
export async function readMachineMemory(): Promise<MachineMemory | null> {
  if (process.platform !== 'darwin') return null
  try {
    const [swap, level] = await Promise.all([sysctl('vm.swapusage'), sysctl('kern.memorystatus_vm_pressure_level')])
    const swapUsedMb = parseSwapUsedMb(swap)
    if (swapUsedMb === null) return null
    return { swapUsedMb, physicalMb: os.totalmem() / 1048576, kernelLevel: Number(level.trim()) || 1 }
  } catch {
    return null
  }
}
