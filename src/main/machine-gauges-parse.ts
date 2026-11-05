// WHAT EACH OS PRINTS, READ INTO NUMBERS. Pure: machine-gauges.ts does the
// asking, and tests/zoom-gauges-fixtures.ts holds what the machines really say.
// Anything unreadable is null, because null is "no reading" on the page and a
// zero there is a claim (shared/machine-gauges.ts).

import { parseSwapUsedMb } from './machine-pressure'
import type { GaugeMemory } from '../shared/machine-gauges'

/** Two looks at these make a CPU percent. Any unit: only the ratio is used. */
export interface CpuTimes {
  idle: number
  total: number
}

export interface SysctlMemory {
  swapUsedMb: number | null
  kernelLevel: number | null
  /** What the kernel could hand back without paging: free, purgeable and file cache. Speculative pages are already inside the file cache. */
  availableBytes: number | null
}

const KIB = 1024

/** `name: value` lines, the shape of `sysctl <names>` and /proc/meminfo. */
function namedLines(text: string): Map<string, string> {
  const lines = new Map<string, string>()
  for (const line of text.split('\n')) {
    const cut = line.indexOf(':')
    if (cut > 0) lines.set(line.slice(0, cut).trim(), line.slice(cut + 1).trim())
  }
  return lines
}

const wholeNumber = (raw: string | undefined): number | null => {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(value) ? value : null
}

/** `sysctl vm.swapusage kern.memorystatus_vm_pressure_level vm.page_*_count hw.pagesize`, by name: any of them may be missing. */
export function parseSysctlMemory(text: string): SysctlMemory {
  const named = namedLines(text)
  const pages = ['vm.page_free_count', 'vm.page_purgeable_count', 'vm.page_pageable_external_count'].map((n) =>
    wholeNumber(named.get(n))
  )
  const pageSize = wholeNumber(named.get('hw.pagesize'))
  const counted = pages.every((n) => n !== null) && pageSize !== null
  return {
    swapUsedMb: parseSwapUsedMb(named.get('vm.swapusage') ?? ''),
    kernelLevel: wholeNumber(named.get('kern.memorystatus_vm_pressure_level')),
    availableBytes: counted ? pages.reduce<number>((sum, n) => sum + (n ?? 0), 0) * pageSize : null
  }
}

/** The busiest of the machine's GPUs from `ioreg -r -c IOAccelerator`; null when no accelerator reports one. */
export function parseIoregGpu(text: string): number | null {
  const found = [...text.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => Number(m[1]))
  return found.length ? Math.min(100, Math.max(...found)) : null
}

/** One line per card from `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`; `[N/A]` is no reading. */
export function parseNvidiaSmi(text: string): number | null {
  const found = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
  return found.length ? Math.min(100, Math.max(...found)) : null
}

/** The machine's line of /proc/stat. Time waiting on the disk counts as idle, as top counts it; guest time is already inside user. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l))
  if (!line) return null
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number)
  if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) return null
  return { idle: fields[3] + fields[4], total: fields.reduce((sum, n) => sum + n, 0) }
}

export function parseProcMeminfo(text: string): GaugeMemory | null {
  const named = namedLines(text)
  const kib = (name: string): number | null => wholeNumber(named.get(name))
  const total = kib('MemTotal')
  if (total === null || total === 0) return null
  // A kernel before 3.14 has no MemAvailable: free plus what it could drop.
  const available = kib('MemAvailable') ?? (kib('MemFree') ?? 0) + (kib('Buffers') ?? 0) + (kib('Cached') ?? 0)
  const swapTotal = kib('SwapTotal')
  const swapFree = kib('SwapFree')
  return {
    usedBytes: Math.max(0, total - available) * KIB,
    totalBytes: total * KIB,
    swapUsedBytes: swapTotal === null || swapFree === null ? null : Math.max(0, swapTotal - swapFree) * KIB,
    kernelLevel: null
  }
}

/** Every core of os.cpus(), summed; null when the OS lists none. */
export function cpuTimesOf(cpus: readonly { times: Record<string, number> }[]): CpuTimes | null {
  if (cpus.length === 0) return null
  return cpus.reduce<CpuTimes>(
    (sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }),
    { idle: 0, total: 0 }
  )
}

/** The busy share of what passed between two looks; null when nothing passed. */
export function cpuPercentOf(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total
  if (total <= 0) return null
  const busy = 1 - (after.idle - before.idle) / total
  return Math.round(Math.min(1, Math.max(0, busy)) * 100)
}
