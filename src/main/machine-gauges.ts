// THE MACHINE'S GAUGES, MAIN SIDE: disk, memory, CPU and GPU, read only while
// somebody is looking at the devices stop. shared/machine-gauges.ts is what
// they mean; machine-gauges-parse.ts reads what each OS prints.
//
// THE RULES ARE THE POINT. This runs on Electron main, on a Mac that may be
// paging, and a sync fork on main stalled the board once (the board probe,
// cookrew-perf-tempo-lane):
//
//   no sync call      every read here is awaited; main never waits on the OS
//   one child at a    a sample's children run in turn, and the watch below
//   time, timed out   allows one sample at a time; SIGKILL, because a process
//                     under swap can take seconds to honour SIGTERM. Nothing
//                     here trusts the kill: a child stuck in the kernel never
//                     exits, so the wait has its own deadline, and one that
//                     outlived it is not forked again until it has gone
//   no clock          there is no timer here to stop. The watch is pull-through:
//                     a reader gets the last sample, or starts the one sample.
//                     Nobody reading is nothing running, so a hold cannot leak
//                     through a crashed window or a phone that went to sleep.

import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process'
import { readdir, readFile, statfs } from 'node:fs/promises'
import os from 'node:os'
import { KERNEL_NORMAL, type GaugeDisk, type GaugeMemory, type MachineGauges } from '../shared/machine-gauges'
import { cpuPercentOf, cpuTimesOf, drmCardIsGpu, parseGpuBusyPercent, pciDeviceIsGpu, parseIoregGpu, parseNvidiaSmi, parseProcMeminfo, parseProcStat, parseSysctlMemory, type CpuTimes } from './machine-gauges-parse'

/** A reading this young is the answer: two watchers share it, and the Mac is asked once. */
export const GAUGE_MIN_AGE_MS = 3_000
export const GAUGE_CHILD_TIMEOUT_MS = 4_000
/** How long a killed child gets to finish before it is given up on. */
export const GAUGE_CHILD_GRACE_MS = 1_000
/** Past every deadline below added up (Linux, the longest: sysfs GPU 4 s, nvidia-smi 4+1 s, disk 4 s, CPU window): a sample this late is stuck, and must not hold the readers that come after it. */
export const GAUGE_SAMPLE_DEADLINE_MS = 16_000
/** A GPU that timed out, failed or said nothing readable is not asked again for this long: forking into a stall makes it worse. */
export const GAUGE_GPU_COOL_MS = 30_000
/** The first look has no earlier one to measure from, so it takes this long to make a rate. */
const CPU_WINDOW_MS = 250
/** An earlier look older than this is not a base: the percent would be an average of the owner's absence. */
const CPU_BASE_MAX_MS = 15_000
const CHILD_MAX_BYTES = 1024 * 1024
const MIB = 1024 * 1024

/** One child answers for all of a Mac's memory: named, so a missing oid costs only itself. */
const MAC_MEMORY_SYSCTLS = [
  'vm.swapusage',
  'kern.memorystatus_vm_pressure_level',
  'vm.page_free_count',
  'vm.page_purgeable_count',
  'vm.page_pageable_external_count',
  'hw.pagesize'
]
/** `-d 1` keeps the accelerator's own node and leaves its tree of clients behind. */
const IOREG_ARGS = ['-r', '-d', '1', '-c', 'IOAccelerator']
const NVIDIA_SMI_ARGS = ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']
/** Where a Linux GPU driver that counts busy time (amdgpu) says so, one file per card. A cloud box's framebuffer has a card here and no such file. */
const DRM_DIR = '/sys/class/drm'
const BUSY_FILE = 'gpu_busy_percent'
/** card0, card1: never a card's connectors (card0-DP-1) or render nodes. */
const DRM_CARD = /^card\d+$/
/** Where a GPU is seen whether or not a driver has made a card of it. */
const PCI_DIR = '/sys/bus/pci/devices'

export interface ChildAnswer {
  stdout: string | null
  failure: 'missing' | 'timeout' | 'failed' | null
}

interface DiskBlocks {
  bavail: number
  blocks: number
  bsize: number
}

/** All the machine this file touches, so a test can be a machine. */
export interface GaugeSamplerPorts {
  platform: NodeJS.Platform
  now: () => number
  run: (command: string, args: readonly string[]) => Promise<ChildAnswer>
  readText: (path: string) => Promise<string | null>
  /** A directory's names. Missing is an answer (there is no such thing); failed is not, and is asked again. */
  listDir: (path: string) => Promise<readonly string[] | 'missing' | 'failed'>
  statfs: (path: string) => Promise<DiskBlocks>
  cpus: () => readonly { times: Record<string, number> }[]
  totalmem: () => number
  freemem: () => number
  /** The disk that matters is the one the owner's files are on. */
  home: string
  delay: (ms: number) => Promise<void>
}

export interface GaugeSampler {
  sample: () => Promise<MachineGauges>
}

type ChildCallback = (error: ExecFileException | null, stdout: string) => void
/** execFile's shape, narrowed to what is used here: a test can be a child that never ends. */
export type GaugeExec = (command: string, args: string[], options: { encoding: 'utf8'; timeout: number; killSignal: 'SIGKILL'; maxBuffer: number; windowsHide: boolean }, done: ChildCallback) => Pick<ChildProcess, 'once' | 'stdout' | 'stderr'>

const answerOf = (error: ExecFileException | null, stdout: string): ChildAnswer => {
  if (!error) return { stdout, failure: null }
  if (error.code === 'ENOENT') return { stdout: null, failure: 'missing' }
  if (error.killed) return { stdout: null, failure: 'timeout' }
  return stdout ? { stdout, failure: null } : { stdout: null, failure: 'failed' }
}

/** Commands whose last child outlived its deadline and has not exited. */
const stuckChildren = new Set<string>()

/**
 * One child, finished by its deadline at the latest, whatever the child does.
 * Whatever it printed before a non-zero exit still counts. execFile answers on
 * `close`, which waits for the child to exit and its pipes to shut, so a process
 * stuck in the kernel, or a grandchild holding stdout, would otherwise never answer.
 */
export function runGaugeChild(command: string, args: readonly string[], timeoutMs = GAUGE_CHILD_TIMEOUT_MS, exec: GaugeExec = execFile): Promise<ChildAnswer> {
  if (stuckChildren.has(command)) return Promise.resolve({ stdout: null, failure: 'timeout' })
  let exited = false
  let answered = (_: ChildAnswer): void => undefined
  const answer = new Promise<ChildAnswer>((resolve) => {
    answered = resolve
  })
  const child = exec(command, [...args], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: CHILD_MAX_BYTES, windowsHide: true }, (error, stdout) =>
    answered(answerOf(error, stdout))
  )
  child.once('exit', () => {
    exited = true
    stuckChildren.delete(command)
  })
  return settleWithin(answer, timeoutMs + GAUGE_CHILD_GRACE_MS).then((settled) => {
    if (settled) return settled
    child.stdout?.destroy()
    child.stderr?.destroy()
    if (!exited) stuckChildren.add(command)
    return { stdout: null, failure: 'timeout' }
  })
}

/** Its answer, or a rejection past the deadline. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Null past the deadline or on a throw: a volume that will not answer costs its own gauge. */
const settleWithin = <T>(work: Promise<T>, ms: number): Promise<T | null> => withDeadline(work, ms).catch(() => null)

/**
 * What a look at the GPU found. A null percent with absent false is a GPU that
 * would not say; absent is a machine with nothing to ask, which the page calls
 * "none" and never "no reading".
 */
interface GpuLook {
  percent: number | null
  absent: boolean
}

const NOT_READ: GpuLook = { percent: null, absent: false }

interface GpuTool {
  command: string
  args: readonly string[]
  parse: (text: string) => number | null
  /** No such tool means no such GPU: true of nvidia-smi; never of ioreg, which every Mac has. */
  missingIsAbsent: boolean
  /** It answered with nothing to read, and that means there is no GPU: ioreg lists only the accelerators there are; nvidia-smi says so in words, where `[N/A]` is a card that would not say. */
  saysAbsent: (stdout: string) => boolean
}

const IOREG: GpuTool = { command: 'ioreg', args: IOREG_ARGS, parse: parseIoregGpu, missingIsAbsent: false, saysAbsent: () => true }
const NVIDIA_SMI: GpuTool = {
  command: 'nvidia-smi',
  args: NVIDIA_SMI_ARGS,
  parse: parseNvidiaSmi,
  missingIsAbsent: true,
  saysAbsent: (stdout) => /No devices were found/i.test(stdout)
}

/**
 * One GPU tool, never asked while it rests: forever once it is not installed, a
 * while after it timed out, failed or said nothing readable, since forking into a
 * stall makes it worse. Whether there is a GPU at all holds through a rest and
 * through a failed ask, which is no news about it, so a box with none does not
 * flicker to "no reading"; only a percent or a new answer changes it.
 */
function gpuToolAsker(tool: GpuTool, ports: Pick<GaugeSamplerPorts, 'now' | 'run'>): () => Promise<GpuLook> {
  let restsUntil = 0
  let absent = false
  return async () => {
    if (ports.now() < restsUntil) return { percent: null, absent }
    const { stdout, failure } = await ports.run(tool.command, tool.args)
    const percent = stdout === null ? null : tool.parse(stdout)
    if (failure === 'missing') restsUntil = Number.POSITIVE_INFINITY
    else if (percent === null) restsUntil = ports.now() + GAUGE_GPU_COOL_MS
    if (percent !== null) absent = false
    else if (failure === 'missing') absent = tool.missingIsAbsent
    else if (failure === null) absent = tool.saysAbsent(stdout ?? '')
    return { percent, absent }
  }
}

/** A DRM card as found: the file it counts busy time in, if its driver keeps one, and whether it is a GPU at all. */
interface DrmCard {
  busyFile: string | null
  gpu: boolean
}

/** What the box has, found once: the busy files to read, and whether any GPU is there at all. */
interface GpuSurvey {
  busyFiles: readonly string[]
  gpu: boolean
}

/** Each in turn, never side by side: every sysfs read holds a libuv thread, and main has four. */
const inTurn = <T, R>(items: readonly T[], each: (item: T) => Promise<R>): Promise<R[]> =>
  items.reduce<Promise<R[]>>(async (done, item) => [...(await done), await each(item)], Promise.resolve([]))

const allAnswered = <T>(found: readonly (T | null)[]): found is T[] => found.every((item) => item !== null)

/**
 * The busiest Linux card that counts its own busy time, read from sysfs with no
 * child. The box is surveyed once, when every listing and read answered: a GPU
 * is not plugged into a running box, and a read that failed is no news.
 *
 * WHETHER THERE IS A GPU comes from the PCI bus as well as the DRM cards: a GPU
 * no driver has bound (a g4dn before its NVIDIA driver) has no card, only the
 * hypervisor's VGA does. Absent needs both to show nothing but display-only
 * devices (drmCardIsGpu, pciDeviceIsGpu); a real GPU whose driver keeps no count
 * (Intel, NVIDIA) is "no reading". A read past its deadline still holds a libuv
 * thread, so none starts behind it, and a count that would not read rests like a
 * GPU tool that failed.
 */
function drmBusyReader(ports: Pick<GaugeSamplerPorts, 'listDir' | 'readText' | 'now'>): () => Promise<GpuLook> {
  let survey: GpuSurvey | null = null
  let out = false
  let restsUntil = 0

  const describeCard = async (card: string): Promise<DrmCard | null> => {
    const device = `${DRM_DIR}/${card}/device`
    const entries = await ports.listDir(device)
    if (entries === 'failed') return null
    if (entries === 'missing') return { busyFile: null, gpu: false }
    const uevent = await ports.readText(`${device}/uevent`)
    if (uevent === null) return null
    return { busyFile: entries.includes(BUSY_FILE) ? `${device}/${BUSY_FILE}` : null, gpu: drmCardIsGpu(uevent) }
  }

  /** Whether a PCI device is a GPU; null when sysfs would not say. Only a display class costs a second read. */
  const pciGpu = async (id: string): Promise<boolean | null> => {
    const pciClass = await ports.readText(`${PCI_DIR}/${id}/class`)
    if (pciClass === null) return null
    if (!pciDeviceIsGpu(pciClass, '')) return false
    const vendor = await ports.readText(`${PCI_DIR}/${id}/vendor`)
    return vendor === null ? null : pciDeviceIsGpu(pciClass, vendor)
  }

  /** Each entry of a directory that may not exist; null when it could not be listed or an entry would not say. */
  const each = async <R>(dir: string, keep: (name: string) => boolean, look: (name: string) => Promise<R | null>): Promise<R[] | null> => {
    const names = await ports.listDir(dir)
    if (names === 'missing') return []
    if (names === 'failed') return null
    const found = await inTurn(names.filter(keep), look)
    return allAnswered(found) ? found : null
  }

  const find = async (): Promise<GpuSurvey | null> => {
    const cards = await each(DRM_DIR, (name) => DRM_CARD.test(name), describeCard)
    if (cards === null) return null
    const pci = await each(PCI_DIR, () => true, pciGpu)
    if (pci === null) return null
    const busyFiles = cards.flatMap((card) => (card.busyFile === null ? [] : [card.busyFile]))
    return { busyFiles, gpu: busyFiles.length > 0 || cards.some((card) => card.gpu) || pci.some(Boolean) }
  }

  const busiest = async (files: readonly string[]): Promise<number | null> => {
    const read = await inTurn(files, async (file) => parseGpuBusyPercent((await ports.readText(file)) ?? ''))
    const seen = read.filter((percent): percent is number => percent !== null)
    return seen.length ? Math.max(...seen) : null
  }

  const look = async (): Promise<GpuLook> => {
    survey ??= await find()
    if (survey === null) return NOT_READ
    if (survey.busyFiles.length === 0) return survey.gpu ? NOT_READ : { percent: null, absent: true }
    const percent = await busiest(survey.busyFiles)
    if (percent === null) restsUntil = ports.now() + GAUGE_GPU_COOL_MS
    return { percent, absent: false }
  }

  return async () => {
    if (out || ports.now() < restsUntil) return NOT_READ
    out = true
    const work = look().finally(() => {
      out = false
    })
    return (await settleWithin(work, GAUGE_CHILD_TIMEOUT_MS)) ?? NOT_READ
  }
}

/** Every way this OS has of asking, as one look: the busiest GPU, and absent only when every way found none. */
function gpuReader(ports: GaugeSamplerPorts): () => Promise<GpuLook> {
  if (ports.platform === 'darwin') return gpuToolAsker(IOREG, ports)
  if (ports.platform !== 'linux') return () => Promise.resolve(NOT_READ)
  const cards = drmBusyReader(ports)
  const nvidia = gpuToolAsker(NVIDIA_SMI, ports)
  return async () => {
    const looks = [await cards(), await nvidia()]
    const percents = looks.flatMap((l) => (l.percent === null ? [] : [l.percent]))
    return percents.length ? { percent: Math.max(...percents), absent: false } : { percent: null, absent: looks.every((l) => l.absent) }
  }
}

export function createGaugeSampler(ports: GaugeSamplerPorts): GaugeSampler {
  let base: { at: number; times: CpuTimes } | null = null
  const readGpu = gpuReader(ports)
  /** A statfs past its deadline still holds a libuv thread, and main has four: never a second one behind it. */
  let statfsOut = false

  const procText = async (path: string): Promise<string> => (await ports.readText(path)) ?? ''

  const cpuNow = async (): Promise<CpuTimes | null> =>
    ports.platform === 'linux' ? parseProcStat(await procText('/proc/stat')) : cpuTimesOf(ports.cpus())

  const macMemory = async (): Promise<GaugeMemory | null> => {
    const { stdout } = await ports.run('sysctl', MAC_MEMORY_SYSCTLS)
    if (stdout === null) return null
    const seen = parseSysctlMemory(stdout)
    const totalBytes = ports.totalmem()
    // os.freemem alone is near zero on a healthy Mac: it is only the floor under a partial answer.
    const available = seen.availableBytes ?? ports.freemem()
    return {
      usedBytes: Math.min(totalBytes, Math.max(0, totalBytes - available)),
      totalBytes,
      swapUsedBytes: seen.swapUsedMb === null ? null : seen.swapUsedMb * MIB,
      // Never null here: a Mac's used memory is not a pressure signal, and null would make it one (memoryTone).
      kernelLevel: seen.kernelLevel ?? KERNEL_NORMAL
    }
  }

  const readMemory = async (): Promise<GaugeMemory | null> => {
    if (ports.platform === 'darwin') return macMemory()
    if (ports.platform === 'linux') return parseProcMeminfo(await procText('/proc/meminfo'))
    const totalBytes = ports.totalmem()
    return { usedBytes: Math.max(0, totalBytes - ports.freemem()), totalBytes, swapUsedBytes: null, kernelLevel: null }
  }

  const readDisk = async (): Promise<GaugeDisk | null> => {
    if (statfsOut) return null
    statfsOut = true
    const asked = ports.statfs(ports.home).finally(() => {
      statfsOut = false
    })
    const blocks = await settleWithin(asked, GAUGE_CHILD_TIMEOUT_MS)
    if (!blocks || blocks.blocks <= 0) return null
    return { freeBytes: blocks.bavail * blocks.bsize, totalBytes: blocks.blocks * blocks.bsize }
  }

  return {
    sample: async () => {
      const baseAge = base === null ? -1 : ports.now() - base.at
      const carried = base !== null && baseAge >= 0 && baseAge <= CPU_BASE_MAX_MS ? base.times : null
      const from = carried ?? (await cpuNow())
      // In turn, on purpose, and memory first: it is the gauge a stalled Mac is being looked at for.
      const memory = await readMemory()
      const gpu = await readGpu()
      const disk = await readDisk()
      if (carried === null) await ports.delay(CPU_WINDOW_MS)
      const to = await cpuNow()
      base = to ? { at: ports.now(), times: to } : null
      return { at: ports.now(), cpuPercent: from && to ? cpuPercentOf(from, to) : null, memory, disk, gpuPercent: gpu.percent, gpuAbsent: gpu.absent }
    }
  }
}

export interface GaugeReader {
  read: () => Promise<MachineGauges>
}

export interface GaugeWatchOptions {
  now?: () => number
  minAgeMs?: number
}

/** The last sample while it is young, else the one sample in flight, else a new one. */
export function createGaugeWatch(sampler: GaugeSampler, options: GaugeWatchOptions = {}): GaugeReader {
  const { now = Date.now, minAgeMs = GAUGE_MIN_AGE_MS } = options
  let last: MachineGauges | null = null
  let flight: Promise<MachineGauges> | null = null
  return {
    read: () => {
      const age = last === null ? -1 : now() - last.at
      if (last && age >= 0 && age < minAgeMs) return Promise.resolve(last)
      flight ??= withDeadline(sampler.sample(), GAUGE_SAMPLE_DEADLINE_MS)
        .then((sample) => {
          last = sample
          return sample
        })
        .finally(() => {
          flight = null
        })
      return flight
    }
  }
}

const realPorts = (): GaugeSamplerPorts => ({
  platform: process.platform,
  now: Date.now,
  run: runGaugeChild,
  readText: (path) => readFile(path, 'utf8').catch(() => null),
  listDir: (path) =>
    readdir(path).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'failed')),
  statfs: (path) => statfs(path),
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  home: os.homedir(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
})

let shared: GaugeReader | null = null

/** This process's one watch: the window and every phone read the same samples. */
export function sharedGaugeWatch(): GaugeReader {
  shared ??= createGaugeWatch(createGaugeSampler(realPorts()))
  return shared
}
