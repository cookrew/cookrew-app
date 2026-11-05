/**
 * THE MACHINE'S GAUGES — what a desktop says about its own load, on the
 * devices stop (zoom/MachineGauges.tsx). Sampled in main only while somebody
 * is looking (main/machine-gauges.ts), carried over IPC to the window and
 * GET /api/levels/gauges to the phone.
 *
 * Null is a word here, not a zero: a gauge that cannot be read says "no
 * reading". A GPU that shows 0% because nobody could ask it reads as an idle
 * GPU, which is a wrong answer that looks right.
 *
 * WHY MEMORY TURNS FIRST. Measured 2026-11-05 on the owner's 16 GB Mac: load
 * 89, 54 % of CPU in the kernel, swap 13.6 of 14.3 GB. The stall was paging,
 * and CPU never looked like the cause. So swap and the kernel's pressure get
 * the warning colour first, and a pegged CPU or GPU only ever warns. Hot is the
 * sleep sweep's own `critical`. Warn comes EARLIER than the sweep's `high`: it
 * takes swap or the kernel where the sweep wants both, so it can stay amber for
 * hours while swap drains after a storm. That is a true reading, not an alarm.
 *
 * A machine with no kernel level to ask (Linux, Windows) warns on used memory
 * instead, or a swapless box would read calm up to the OOM killer. A Mac never
 * does: it keeps memory full by design, so there the share means nothing.
 */

/** Swap against physical RAM: a quarter is the storm's first sign, half is the storm. */
export const HIGH_SWAP_SHARE = 0.25
export const CRITICAL_SWAP_SHARE = 0.5
/** kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
export const KERNEL_NORMAL = 1
export const KERNEL_WARN = 2
export const KERNEL_CRITICAL = 4

/** Used memory against total, where no kernel can say better. */
const HIGH_USED_SHARE = 0.9
const CRITICAL_USED_SHARE = 0.97
/** At or over this a CPU or GPU warns; neither ever goes hot. */
const BUSY_PERCENT = 90
/** Under these shares of the disk free, it warns, then goes hot. */
const DISK_LOW_SHARE = 0.1
const DISK_OUT_SHARE = 0.05

export const NO_READING = 'no reading'

export interface GaugeMemory {
  usedBytes: number
  totalBytes: number
  /** Null where the OS gives no figure (Windows): not the same as none in use. */
  swapUsedBytes: number | null
  /** Null off macOS: only the Mac's kernel says this. */
  kernelLevel: number | null
}

export interface GaugeDisk {
  freeBytes: number
  totalBytes: number
}

export interface MachineGauges {
  /** When it was read, ms since the epoch. */
  at: number
  cpuPercent: number | null
  memory: GaugeMemory | null
  disk: GaugeDisk | null
  gpuPercent: number | null
}

export type GaugeTone = 'calm' | 'warn' | 'hot'

export interface GaugeCell {
  key: 'cpu' | 'memory' | 'disk' | 'gpu'
  label: string
  value: string
  /** A second line: memory's swap. */
  sub: string | null
  /** How full the bar is, 0 to 1; null draws no bar. */
  share: number | null
  tone: GaugeTone
}

const size = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const percent = (value: unknown): number | null => (size(value) && value <= 100 ? value : null)
const row = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function parseMemory(raw: unknown): GaugeMemory | null {
  const m = row(raw)
  if (!m || !size(m.usedBytes) || !size(m.totalBytes) || m.totalBytes === 0) return null
  return {
    usedBytes: m.usedBytes,
    totalBytes: m.totalBytes,
    swapUsedBytes: size(m.swapUsedBytes) ? m.swapUsedBytes : null,
    kernelLevel: size(m.kernelLevel) ? m.kernelLevel : null
  }
}

function parseDisk(raw: unknown): GaugeDisk | null {
  const d = row(raw)
  return d && size(d.freeBytes) && size(d.totalBytes) && d.totalBytes > 0 ? { freeBytes: d.freeBytes, totalBytes: d.totalBytes } : null
}

/** A reading as a machine sent it, every field checked. Null when it is not one; a bad field is that gauge's no reading. */
export function parseMachineGauges(raw: unknown): MachineGauges | null {
  const g = row(raw)
  if (!g || !size(g.at)) return null
  return { at: g.at, cpuPercent: percent(g.cpuPercent), memory: parseMemory(g.memory), disk: parseDisk(g.disk), gpuPercent: percent(g.gpuPercent) }
}

export function memoryTone(memory: GaugeMemory): GaugeTone {
  const share = (memory.swapUsedBytes ?? 0) / memory.totalBytes
  const level = memory.kernelLevel ?? 0
  const used = memory.kernelLevel === null ? memory.usedBytes / memory.totalBytes : 0
  if (level >= KERNEL_CRITICAL || share >= CRITICAL_SWAP_SHARE || used >= CRITICAL_USED_SHARE) return 'hot'
  return level >= KERNEL_WARN || share >= HIGH_SWAP_SHARE || used >= HIGH_USED_SHARE ? 'warn' : 'calm'
}

function diskTone(disk: GaugeDisk): GaugeTone {
  const free = disk.freeBytes / disk.totalBytes
  if (free < DISK_OUT_SHARE) return 'hot'
  return free < DISK_LOW_SHARE ? 'warn' : 'calm'
}

const GIB = 1024 ** 3
const GB = 1e9
const TB = 1e12

/** Memory in binary GB, so 16 GB of RAM says 16; "14.0" drops to 14. */
const gib = (bytes: number): string => String(Number((bytes / GIB).toFixed(1)))
const swapWords = (bytes: number | null): string =>
  bytes === null ? `swap ${NO_READING}` : `swap ${bytes === 0 ? '0' : (bytes / GIB).toFixed(1)} GB`
/** A disk in decimal, as Finder and the box it came in count it. */
const freeWords = (bytes: number): string =>
  bytes >= TB ? `${(bytes / TB).toFixed(1)} TB free` : `${Math.round(bytes / GB)} GB free`

function busyCell(key: 'cpu' | 'gpu', label: string, value: number | null): GaugeCell {
  if (value === null) return { key, label, value: NO_READING, sub: null, share: null, tone: 'calm' }
  return { key, label, value: `${Math.round(value)}%`, sub: null, share: value / 100, tone: value >= BUSY_PERCENT ? 'warn' : 'calm' }
}

function memoryCell(memory: GaugeMemory | null): GaugeCell {
  if (!memory) return { key: 'memory', label: 'MEM', value: NO_READING, sub: null, share: null, tone: 'calm' }
  return {
    key: 'memory',
    label: 'MEM',
    value: `${gib(memory.usedBytes)}/${gib(memory.totalBytes)} GB`,
    sub: swapWords(memory.swapUsedBytes),
    share: memory.usedBytes / memory.totalBytes,
    tone: memoryTone(memory)
  }
}

function diskCell(disk: GaugeDisk | null): GaugeCell {
  if (!disk) return { key: 'disk', label: 'DISK', value: NO_READING, sub: null, share: null, tone: 'calm' }
  return { key: 'disk', label: 'DISK', value: freeWords(disk.freeBytes), sub: null, share: 1 - disk.freeBytes / disk.totalBytes, tone: diskTone(disk) }
}

/** The four gauges as they are drawn, in the owner's order. */
export function gaugeCells(gauges: MachineGauges): GaugeCell[] {
  return [busyCell('cpu', 'CPU', gauges.cpuPercent), memoryCell(gauges.memory), diskCell(gauges.disk), busyCell('gpu', 'GPU', gauges.gpuPercent)]
}
