// THE GAUGES' WORDS: what each OS prints, read into numbers; what the numbers
// are allowed to look like on the wire; and which of them may go warm. The
// rule behind the tones is the 2026-11-05 storm (cookrew-fleet-memory-storm):
// paging stalls this fleet, not CPU, so memory turns first.
import { describe, expect, it } from 'vitest'
import {
  cpuPercentOf,
  cpuTimesOf,
  drmCardIsGpu,
  pciDeviceIsGpu,
  parseGpuBusyPercent,
  parseIoregGpu,
  parseNvidiaSmi,
  parseProcMeminfo,
  parseProcStat,
  parseSysctlMemory
} from '../src/main/machine-gauges-parse'
import { gaugeCells, memoryTone, NO_GPU, NO_READING, parseMachineGauges, type MachineGauges } from '../src/shared/machine-gauges'
import { pressureOf } from '../src/main/machine-pressure'
import * as fx from './zoom-gauges-fixtures'

const GB = 1024 ** 3
const reading = (over: Partial<MachineGauges> = {}): MachineGauges => ({
  at: 1,
  cpuPercent: 34,
  memory: { usedBytes: 14.4 * GB, totalBytes: 16 * GB, swapUsedBytes: 7 * GB, kernelLevel: 1 },
  disk: { freeBytes: 212e9, totalBytes: 994e9 },
  gpuPercent: 12,
  gpuAbsent: false,
  ...over
})
const cell = (g: MachineGauges, key: string) => gaugeCells(g).find((c) => c.key === key)!

describe('ioreg', () => {
  it('reads Device Utilization % out of the PerformanceStatistics line', () => {
    expect(parseIoregGpu(fx.IOREG_APPLE)).toBe(23)
  })
  it('is not fooled by the Tiler and Renderer figures beside it', () => {
    expect(parseIoregGpu(fx.IOREG_APPLE)).not.toBe(4)
    expect(parseIoregGpu(fx.IOREG_APPLE)).not.toBe(9)
  })
  it('takes the busiest of two GPUs', () => {
    expect(parseIoregGpu(fx.IOREG_TWO_GPUS)).toBe(61)
  })
  it('a real idle GPU is 0, a GPU with no statistics is no reading', () => {
    expect(parseIoregGpu('"PerformanceStatistics" = {"Device Utilization %"=0}')).toBe(0)
    expect(parseIoregGpu(fx.IOREG_NO_STATISTICS)).toBeNull()
    expect(parseIoregGpu('')).toBeNull()
  })
})

describe('sysctl', () => {
  it('reads swap, the kernel level and what could be handed back, by name', () => {
    const m = parseSysctlMemory(fx.SYSCTL_STORM)
    expect(m.swapUsedMb).toBeCloseTo(8981.12)
    expect(m.kernelLevel).toBe(2)
    // Speculative pages are inside the file-backed count: adding them counts them twice.
    expect(m.availableBytes).toBe((906 + 661 + 88829) * 16384)
  })
  it('keeps swap when the page counts did not answer', () => {
    const m = parseSysctlMemory(fx.SYSCTL_SWAP_ONLY)
    expect(m.swapUsedMb).toBeCloseTo(3591.06)
    expect(m.kernelLevel).toBeNull()
    expect(m.availableBytes).toBeNull()
  })
  it('understands swap in gigabytes', () => {
    expect(parseSysctlMemory(fx.SYSCTL_GIGABYTES).swapUsedMb).toBeCloseTo(13.6 * 1024)
  })
  it('says nothing about nothing', () => {
    expect(parseSysctlMemory('')).toEqual({ swapUsedMb: null, kernelLevel: null, availableBytes: null })
  })
})

describe('/proc', () => {
  it('reads the machine line of /proc/stat, not one core', () => {
    expect(parseProcStat(fx.PROC_STAT_A)).toEqual({ idle: 16250 + 520, total: 4705 + 150 + 1120 + 16250 + 520 + 30 + 12 })
  })
  it('counts time waiting on the disk as idle, as top does', () => {
    expect(cpuPercentOf(parseProcStat(fx.PROC_STAT_A)!, parseProcStat(fx.PROC_STAT_B)!)).toBe(60)
  })
  it('refuses a /proc/stat with no machine line', () => {
    expect(parseProcStat('intr 1 2 3\n')).toBeNull()
  })
  it('reads /proc/meminfo in bytes, with swap as total less free', () => {
    const m = parseProcMeminfo(fx.PROC_MEMINFO)!
    expect(m.totalBytes).toBe(16303428 * 1024)
    expect(m.usedBytes).toBe((16303428 - 6291456) * 1024)
    expect(m.swapUsedBytes).toBe((8388604 - 4194300) * 1024)
    expect(m.kernelLevel).toBeNull()
  })
  it('falls back to free, buffers and cache on an old kernel; no swap configured is zero used', () => {
    const m = parseProcMeminfo(fx.PROC_MEMINFO_OLD)!
    expect(m.usedBytes).toBe((8000000 - 3000000) * 1024)
    expect(m.swapUsedBytes).toBe(0)
  })
  it('refuses a meminfo with no total', () => {
    expect(parseProcMeminfo('MemFree: 12 kB\n')).toBeNull()
  })
})

describe('nvidia-smi', () => {
  it('reads one card, and the busiest of two', () => {
    expect(parseNvidiaSmi(fx.NVIDIA_SMI_ONE)).toBe(37)
    expect(parseNvidiaSmi(fx.NVIDIA_SMI_TWO)).toBe(88)
  })
  it('a card with no counter is no reading, never 0', () => {
    expect(parseNvidiaSmi(fx.NVIDIA_SMI_NA)).toBeNull()
    expect(parseNvidiaSmi('')).toBeNull()
  })
})

describe('gpu_busy_percent', () => {
  it('reads the one number amdgpu writes there', () => {
    expect(parseGpuBusyPercent('37\n')).toBe(37)
    expect(parseGpuBusyPercent('0\n')).toBe(0)
  })
  it('anything else is no reading, never 0, and never past 100', () => {
    for (const text of ['', '\n', '-1', 'busy', '3.5']) expect(parseGpuBusyPercent(text)).toBeNull()
    expect(parseGpuBusyPercent('150')).toBe(100)
  })
})

describe('a DRM card’s uevent', () => {
  it('a real GPU is one, whether or not its driver counts busy time', () => {
    for (const uevent of [fx.UEVENT_AMDGPU, fx.UEVENT_I915, fx.UEVENT_NVIDIA]) expect(drmCardIsGpu(uevent)).toBe(true)
  })
  it('a firmware framebuffer, a hypervisor’s VGA or a BMC’s display is not', () => {
    for (const uevent of [fx.UEVENT_SIMPLEDRM, fx.UEVENT_AMAZON_VGA, fx.UEVENT_ASPEED, 'DRIVER=bochs-drm\nPCI_ID=1234:1111\n']) expect(drmCardIsGpu(uevent)).toBe(false)
  })
  it('a card nobody recognises counts as a GPU: unsure is no reading, never a none that might be false', () => {
    expect(drmCardIsGpu('')).toBe(true)
    expect(drmCardIsGpu('DRIVER=panfrost\n')).toBe(true)
  })
})

describe('a PCI device', () => {
  it('a display or 3D controller is a GPU, bound to a driver or not', () => {
    expect(pciDeviceIsGpu('0x030200\n', '0x10de\n')).toBe(true)
    expect(pciDeviceIsGpu('0x030000\n', '0x8086\n')).toBe(true)
    expect(pciDeviceIsGpu('0x038000\n', '0x1002\n')).toBe(true)
  })
  it('a hypervisor’s or a BMC’s display is not, and nothing outside class 0x03 is', () => {
    expect(pciDeviceIsGpu('0x030000\n', '0x1d0f\n')).toBe(false)
    expect(pciDeviceIsGpu('0x030000\n', '0x1a03\n')).toBe(false)
    expect(pciDeviceIsGpu('0x010802\n', '0x10de\n')).toBe(false)
  })
})

describe('os.cpus deltas', () => {
  const core = (user: number, sys: number, idle: number) => ({ times: { user, nice: 0, sys, idle, irq: 0 } })
  it('sums every core', () => {
    expect(cpuTimesOf([core(10, 5, 85), core(20, 10, 70)])).toEqual({ idle: 155, total: 200 })
  })
  it('is the busy share of what passed between two looks', () => {
    expect(cpuPercentOf({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(50)
  })
  it('two looks with nothing between them are no reading, not 0 or NaN', () => {
    expect(cpuPercentOf({ idle: 1, total: 2 }, { idle: 1, total: 2 })).toBeNull()
    expect(cpuTimesOf([])).toBeNull()
  })
  it('never leaves 0..100, whatever a counter wrapped to', () => {
    expect(cpuPercentOf({ idle: 500, total: 600 }, { idle: 100, total: 700 })).toBe(100)
  })
})

describe('the wire', () => {
  it('keeps a whole reading as it is', () => {
    expect(parseMachineGauges(reading())).toEqual(reading())
  })
  it('keeps a reading with gauges missing: each one is its own no reading', () => {
    const none = reading({ cpuPercent: null, memory: null, disk: null, gpuPercent: null })
    expect(parseMachineGauges(none)).toEqual(none)
  })
  it('refuses what is not a reading', () => {
    for (const raw of [null, 'x', [], {}, { at: 'now' }]) expect(parseMachineGauges(raw)).toBeNull()
  })
  it('a field out of shape becomes no reading rather than a wrong number on the page', () => {
    const parsed = parseMachineGauges({ ...reading(), cpuPercent: 900, gpuPercent: '12', disk: { freeBytes: -1, totalBytes: 10 }, memory: { usedBytes: 1 } })
    expect(parsed).toEqual({ at: 1, cpuPercent: null, memory: null, disk: null, gpuPercent: null, gpuAbsent: false })
  })
  it('keeps a machine that has no GPU apart from a GPU that could not be read', () => {
    expect(parseMachineGauges(reading({ gpuPercent: null, gpuAbsent: true }))?.gpuAbsent).toBe(true)
    expect(parseMachineGauges(reading({ gpuPercent: null, gpuAbsent: false }))?.gpuAbsent).toBe(false)
  })
  it('a reading sent before there was a word for no GPU reads exactly as it did: a null GPU is no reading', () => {
    const { gpuAbsent: _, ...old } = reading({ gpuPercent: null })
    expect(parseMachineGauges(old)).toEqual(reading({ gpuPercent: null, gpuAbsent: false }))
    const { gpuAbsent: __, ...oldBusy } = reading()
    expect(parseMachineGauges(oldBusy)).toEqual(reading())
  })
  it('a percent outranks a claim of no GPU, and only true is a claim', () => {
    expect(parseMachineGauges(reading({ gpuPercent: 12, gpuAbsent: true }))).toMatchObject({ gpuPercent: 12, gpuAbsent: false })
    for (const raw of ['true', 1, 'none', null]) expect(parseMachineGauges({ ...reading({ gpuPercent: null }), gpuAbsent: raw })?.gpuAbsent).toBe(false)
  })
  it('the GPU percent keeps its name, so a client that has never heard of gpuAbsent still reads no reading, as before', () => {
    expect(JSON.parse(JSON.stringify(reading({ gpuPercent: null, gpuAbsent: true })))).toHaveProperty('gpuPercent', null)
  })
})

describe('the warning colour goes to memory first', () => {
  const mem = (swapGb: number, kernelLevel: number | null = 1) => ({ usedBytes: 15 * GB, totalBytes: 16 * GB, swapUsedBytes: swapGb * GB, kernelLevel })
  it('stays calm under a quarter of RAM in swap with the kernel calm', () => {
    expect(memoryTone(mem(3.9))).toBe('calm')
  })
  it('warms at a quarter of RAM in swap, even with the kernel calm: that is the storm note’s line', () => {
    expect(memoryTone(mem(4))).toBe('warn')
  })
  it('warms when the kernel says warn, with no swap at all', () => {
    expect(memoryTone(mem(0, 2))).toBe('warn')
  })
  it('goes hot at half of RAM in swap or the kernel saying critical', () => {
    expect(memoryTone(mem(8))).toBe('hot')
    expect(memoryTone(mem(0, 4))).toBe('hot')
  })
  it('never goes hot where the sleep sweep would not call it critical', () => {
    for (const swap of [0, 3, 4, 7.9, 8, 13.6]) for (const level of [1, 2, 4]) {
      const hot = memoryTone(mem(swap, level)) === 'hot'
      expect(hot).toBe(pressureOf({ swapUsedMb: swap * 1024, physicalMb: 16 * 1024, kernelLevel: level }) === 'critical')
    }
  })
  it('reads a box with no kernel level, and one with no swap figure, by what it has', () => {
    const light = { ...mem(0, null), usedBytes: 8 * GB }
    expect(memoryTone({ ...light, swapUsedBytes: 5 * GB })).toBe('warn')
    expect(memoryTone({ ...light, swapUsedBytes: null })).toBe('calm')
  })
  it('with no kernel to ask, a box near full says so itself: a swapless Linux must warn before the OOM killer does', () => {
    const at = (usedGb: number) => ({ usedBytes: usedGb * GB, totalBytes: 16 * GB, swapUsedBytes: 0, kernelLevel: null })
    expect(memoryTone(at(14))).toBe('calm')
    expect(memoryTone(at(14.6))).toBe('warn')
    expect(memoryTone(at(15.9))).toBe('hot')
  })
  it('a Mac’s used memory never decides its tone: the kernel and swap do', () => {
    expect(memoryTone({ usedBytes: 15.9 * GB, totalBytes: 16 * GB, swapUsedBytes: 0, kernelLevel: 1 })).toBe('calm')
  })
  it('the storm’s own numbers: memory hot, CPU at 54 % calm', () => {
    const storm = reading({ cpuPercent: 54, memory: mem(13.6, 2) })
    expect(cell(storm, 'memory').tone).toBe('hot')
    expect(cell(storm, 'cpu').tone).toBe('calm')
  })
  it('a pegged CPU or GPU only ever warns: hot is memory’s and the disk’s', () => {
    const pegged = reading({ cpuPercent: 100, gpuPercent: 100, memory: mem(0) })
    expect(cell(pegged, 'cpu').tone).toBe('warn')
    expect(cell(pegged, 'gpu').tone).toBe('warn')
    expect(cell(pegged, 'memory').tone).toBe('calm')
  })
  it('a filling disk warns under a tenth free and is hot under a twentieth', () => {
    const disk = (free: number) => cell(reading({ disk: { freeBytes: free, totalBytes: 1000e9 } }), 'disk').tone
    expect(disk(101e9)).toBe('calm')
    expect(disk(99e9)).toBe('warn')
    expect(disk(49e9)).toBe('hot')
  })
})

describe('the cells', () => {
  it('are CPU, memory, disk, GPU, in the owner’s order', () => {
    expect(gaugeCells(reading()).map((c) => c.key)).toEqual(['cpu', 'memory', 'disk', 'gpu'])
  })
  it('say the percent, used of total, swap used and free space', () => {
    const g = reading()
    expect(cell(g, 'cpu').value).toBe('34%')
    expect(cell(g, 'memory').value).toBe('14.4/16 GB')
    expect(cell(g, 'memory').sub).toBe('swap 7.0 GB')
    expect(cell(g, 'disk').value).toBe('212 GB free')
    expect(cell(g, 'gpu').value).toBe('12%')
  })
  it('swap is shown when it is zero, because zero is the good news', () => {
    expect(cell(reading({ memory: { usedBytes: GB, totalBytes: 16 * GB, swapUsedBytes: 0, kernelLevel: 1 } }), 'memory').sub).toBe('swap 0 GB')
  })
  it('says so when the OS has no swap figure, rather than printing zero', () => {
    expect(cell(reading({ memory: { usedBytes: GB, totalBytes: 16 * GB, swapUsedBytes: null, kernelLevel: null } }), 'memory').sub).toBe('swap no reading')
  })
  it('counts a big disk in TB', () => {
    expect(cell(reading({ disk: { freeBytes: 1.25e12, totalBytes: 2e12 } }), 'disk').value).toBe('1.3 TB free')
  })
  it('a GPU with no reading says so and draws no bar: it never shows 0%', () => {
    const gpu = cell(reading({ gpuPercent: null }), 'gpu')
    expect(gpu.value).toBe(NO_READING)
    expect(gpu.value).not.toContain('0%')
    expect(gpu.share).toBeNull()
    expect(gpu.tone).toBe('calm')
  })
  it('a machine with no GPU says none, with no bar, and never no reading: it is an answer, not a failure', () => {
    const gpu = cell(reading({ gpuPercent: null, gpuAbsent: true }), 'gpu')
    expect(gpu).toEqual({ key: 'gpu', label: 'GPU', value: NO_GPU, sub: null, share: null, tone: 'calm' })
    expect(NO_GPU).toBe('none')
    expect(NO_GPU).not.toBe(NO_READING)
  })
  it('keeps the GPU cell for a machine with none: the panel is one grid, and a dropped cell would pull the next machine into its column', () => {
    expect(gaugeCells(reading({ gpuPercent: null, gpuAbsent: true })).map((c) => c.key)).toEqual(['cpu', 'memory', 'disk', 'gpu'])
  })
  it('a GPU really at rest does say 0%', () => {
    expect(cell(reading({ gpuPercent: 0 }), 'gpu').value).toBe('0%')
  })
  it('every missing gauge says the same words, with no bar', () => {
    for (const c of gaugeCells(reading({ cpuPercent: null, memory: null, disk: null, gpuPercent: null }))) {
      expect(c.value).toBe(NO_READING)
      expect(c.share).toBeNull()
    }
  })
  it('a bar is how full the thing is: used memory, used disk, between 0 and 1', () => {
    expect(cell(reading(), 'memory').share).toBeCloseTo(0.9)
    expect(cell(reading(), 'disk').share).toBeCloseTo(1 - 212 / 994)
    expect(cell(reading(), 'cpu').share).toBeCloseTo(0.34)
  })
})
