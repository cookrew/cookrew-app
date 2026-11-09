// THE SAMPLER'S HARD RULES (owner, device-gauges): async only, one child at a
// time with a timeout, and nothing at all running while nobody looks. A sync
// fork on main stalled the board once (cookrew-perf-tempo-lane).
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGaugeSampler,
  createGaugeWatch,
  GAUGE_CHILD_GRACE_MS,
  GAUGE_CHILD_TIMEOUT_MS,
  GAUGE_GPU_COOL_MS,
  GAUGE_MIN_AGE_MS,
  GAUGE_SAMPLE_DEADLINE_MS,
  runGaugeChild,
  type ChildAnswer,
  type GaugeSamplerPorts
} from '../src/main/machine-gauges'
import { memoryTone, type MachineGauges } from '../src/shared/machine-gauges'
import * as fx from './zoom-gauges-fixtures'

const GB = 1024 ** 3
const ok = (stdout: string): ChildAnswer => ({ stdout, failure: null })
const core = (busy: number, idle: number) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } })

interface Fake extends GaugeSamplerPorts {
  ran: string[]
  listed: string[]
  clock: { at: number }
  active: { now: number; peak: number }
}

function fake(
  over: Partial<GaugeSamplerPorts> & { answers?: Record<string, ChildAnswer>; files?: Record<string, string>; dirs?: Record<string, readonly string[] | 'failed'> } = {}
): Fake {
  const { answers = {}, files = {}, dirs = {}, ...ports } = over
  const clock = { at: 1000 }
  const active = { now: 0, peak: 0 }
  const ran: string[] = []
  const listed: string[] = []
  let idle = 0
  return {
    ran,
    listed,
    clock,
    active,
    platform: 'darwin',
    now: () => clock.at,
    run: async (command) => {
      ran.push(command)
      active.now += 1
      active.peak = Math.max(active.peak, active.now)
      await Promise.resolve()
      active.now -= 1
      return answers[command] ?? { stdout: null, failure: 'missing' }
    },
    readText: async (path) => files[path] ?? null,
    listDir: async (path) => {
      listed.push(path)
      return dirs[path] ?? 'missing'
    },
    statfs: async () => ({ bavail: 50, blocks: 100, bsize: 1e9 }),
    cpus: () => {
      idle += 50
      return [core(idle, idle)]
    },
    totalmem: () => 16 * GB,
    freemem: () => 1 * GB,
    home: '/Users/owner',
    delay: async () => undefined,
    ...ports
  }
}

const mac = (over: Parameters<typeof fake>[0] = {}): Fake =>
  fake({ answers: { sysctl: ok(fx.SYSCTL_STORM), ioreg: ok(fx.IOREG_APPLE) }, ...over })

describe('on a Mac', () => {
  it('reads all four gauges', async () => {
    const g = await createGaugeSampler(mac()).sample()
    expect(g.cpuPercent).toBe(50)
    expect(g.gpuPercent).toBe(23)
    expect(g.disk).toEqual({ freeBytes: 50e9, totalBytes: 100e9 })
    expect(g.memory?.totalBytes).toBe(16 * GB)
    expect(g.memory?.swapUsedBytes).toBeCloseTo(8981.12 * 1024 * 1024)
    expect(g.memory?.kernelLevel).toBe(2)
  })
  it('used memory is what could not be handed back, never total less the near-zero free', async () => {
    const g = await createGaugeSampler(mac()).sample()
    expect(g.memory?.usedBytes).toBe(16 * GB - (906 + 661 + 88829) * 16384)
  })
  it('spends two children a sample: one sysctl for all of memory, one ioreg', async () => {
    const ports = mac()
    await createGaugeSampler(ports).sample()
    expect(ports.ran).toEqual(['sysctl', 'ioreg'])
  })
  it('runs them one at a time', async () => {
    const ports = mac()
    await createGaugeSampler(ports).sample()
    expect(ports.active.peak).toBe(1)
  })
  it('asks for the disk the owner’s files are on', async () => {
    const statfs = vi.fn(async () => ({ bavail: 1, blocks: 2, bsize: 1 }))
    await createGaugeSampler(mac({ statfs })).sample()
    expect(statfs).toHaveBeenCalledWith('/Users/owner')
  })
  it('memory is no reading when sysctl fails: os.freemem alone would claim the Mac is full', async () => {
    const g = await createGaugeSampler(mac({ answers: { ioreg: ok(fx.IOREG_APPLE) } })).sample()
    expect(g.memory).toBeNull()
  })
  it('keeps swap when only the page counts failed', async () => {
    const g = await createGaugeSampler(mac({ answers: { sysctl: ok(fx.SYSCTL_SWAP_ONLY), ioreg: ok(fx.IOREG_APPLE) } })).sample()
    expect(g.memory?.swapUsedBytes).toBeCloseTo(3591.06 * 1024 * 1024)
    expect(g.memory?.usedBytes).toBe(15 * GB)
  })
  it('a Mac whose kernel level did not answer stays a Mac: its near-zero free must not read as full', async () => {
    const g = await createGaugeSampler(mac({ answers: { sysctl: ok(fx.SYSCTL_SWAP_ONLY), ioreg: ok(fx.IOREG_APPLE) } })).sample()
    expect(memoryTone(g.memory!)).toBe('calm')
  })
  it('a Mac with no GPU statistics has no GPU reading: null, not 0', async () => {
    const g = await createGaugeSampler(mac({ answers: { sysctl: ok(fx.SYSCTL_CALM), ioreg: ok(fx.IOREG_NO_STATISTICS) } })).sample()
    expect(g.gpuPercent).toBeNull()
  })
  it('a Mac whose accelerators report no utilisation has no GPU to read: none, not no reading', async () => {
    const g = await createGaugeSampler(mac({ answers: { sysctl: ok(fx.SYSCTL_CALM), ioreg: ok(fx.IOREG_NO_STATISTICS) } })).sample()
    expect(g.gpuAbsent).toBe(true)
  })
  it('an ioreg that lists no accelerator at all is no GPU too', async () => {
    const g = await createGaugeSampler(mac({ answers: { sysctl: ok(fx.SYSCTL_CALM), ioreg: ok('') } })).sample()
    expect(g).toMatchObject({ gpuPercent: null, gpuAbsent: true })
  })
  it('stays none while the GPU rests between asks: no flicker to no reading', async () => {
    const ports = mac({ answers: { sysctl: ok(fx.SYSCTL_CALM), ioreg: ok(fx.IOREG_NO_STATISTICS) } })
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at += 4000
    expect((await sampler.sample()).gpuAbsent).toBe(true)
    expect(ports.ran.filter((c) => c === 'ioreg')).toHaveLength(1)
  })
  it('a Mac shown to have no GPU stays none through an ioreg that timed out: a failed ask is not news', async () => {
    const answers: Record<string, ChildAnswer> = { sysctl: ok(fx.SYSCTL_CALM), ioreg: ok(fx.IOREG_NO_STATISTICS) }
    const ports = mac({ answers })
    const sampler = createGaugeSampler(ports)
    expect((await sampler.sample()).gpuAbsent).toBe(true)
    answers.ioreg = { stdout: null, failure: 'timeout' }
    ports.clock.at += GAUGE_GPU_COOL_MS
    expect((await sampler.sample()).gpuAbsent).toBe(true)
    ports.clock.at += GAUGE_GPU_COOL_MS
    expect((await sampler.sample()).gpuAbsent).toBe(true)
    answers.ioreg = ok(fx.IOREG_APPLE)
    ports.clock.at += GAUGE_GPU_COOL_MS
    expect(await sampler.sample()).toMatchObject({ gpuPercent: 23, gpuAbsent: false })
  })
  it('a Mac GPU that answers is not absent; one whose ioreg timed out or is missing is no reading, not none', async () => {
    expect((await createGaugeSampler(mac()).sample()).gpuAbsent).toBe(false)
    const slow = await createGaugeSampler(mac({ answers: { sysctl: ok(fx.SYSCTL_CALM), ioreg: { stdout: null, failure: 'timeout' } } })).sample()
    expect(slow).toMatchObject({ gpuPercent: null, gpuAbsent: false })
    const broken = await createGaugeSampler(mac({ answers: { sysctl: ok(fx.SYSCTL_CALM) } })).sample()
    expect(broken).toMatchObject({ gpuPercent: null, gpuAbsent: false })
  })
})

describe('the CPU window', () => {
  it('the first look waits out a short window: one look is not a rate', async () => {
    const delay = vi.fn(async () => undefined)
    await createGaugeSampler(mac({ delay })).sample()
    expect(delay).toHaveBeenCalledTimes(1)
  })
  it('the next look measures from the last one and does not wait', async () => {
    const delay = vi.fn(async () => undefined)
    const ports = mac({ delay })
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at += 4000
    await sampler.sample()
    expect(delay).toHaveBeenCalledTimes(1)
  })
  it('a clock set back is no base either', async () => {
    const delay = vi.fn(async () => undefined)
    const ports = mac({ delay })
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at -= 60_000
    await sampler.sample()
    expect(delay).toHaveBeenCalledTimes(2)
  })
  it('a base left from long ago is not averaged over: the owner came back to the stop', async () => {
    const delay = vi.fn(async () => undefined)
    const ports = mac({ delay })
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at += 10 * 60_000
    await sampler.sample()
    expect(delay).toHaveBeenCalledTimes(2)
  })
})

describe('on Linux', () => {
  const linux = (over: Parameters<typeof fake>[0] = {}): Fake => {
    let reads = 0
    const files = over.files ?? {}
    return fake({
      platform: 'linux',
      readText: async (path) => {
        if (path === '/proc/stat') return reads++ === 0 ? fx.PROC_STAT_A : fx.PROC_STAT_B
        return path === '/proc/meminfo' ? fx.PROC_MEMINFO : (files[path] ?? null)
      },
      ...over
    })
  }
  const DRM = '/sys/class/drm'
  const BUSY0 = `${DRM}/card0/device/gpu_busy_percent`
  const BUSY1 = `${DRM}/card1/device/gpu_busy_percent`
  const PCI = '/sys/bus/pci/devices'
  /** The PCI bus as sysfs lists it: a directory of devices, each with its class and vendor. */
  const bus = (devices: Record<string, { class: string; vendor: string }>) => ({
    dirs: { [PCI]: Object.keys(devices) },
    files: Object.fromEntries(
      Object.entries(devices).flatMap(([id, d]) => [
        [`${PCI}/${id}/class`, d.class],
        [`${PCI}/${id}/vendor`, d.vendor]
      ])
    )
  })
  /** A box with one DRM card, described by its device/uevent, on a PCI bus. */
  const oneCard = (uevent: string, devices: Record<string, { class: string; vendor: string }> = {}) => {
    const pci = bus(devices)
    return {
      dirs: { [DRM]: fx.DRM_EC2, [`${DRM}/card0/device`]: fx.DRM_DEVICE_SILENT, ...pci.dirs },
      files: { [`${DRM}/card0/device/uevent`]: uevent, ...pci.files }
    }
  }
  const SOLIS = oneCard(fx.UEVENT_SIMPLEDRM, fx.PCI_EC2)
  const twoAmd = (busy: Record<string, string>) => ({
    dirs: { [DRM]: fx.DRM_TWO_AMD, [`${DRM}/card0/device`]: fx.DRM_DEVICE_COUNTS, [`${DRM}/card1/device`]: fx.DRM_DEVICE_COUNTS },
    files: { [`${DRM}/card0/device/uevent`]: fx.UEVENT_AMDGPU, [`${DRM}/card1/device/uevent`]: fx.UEVENT_AMDGPU, ...busy }
  })

  it('reads /proc for CPU and memory, statfs for the disk, no child at all without nvidia-smi', async () => {
    const ports = linux()
    const g = await createGaugeSampler(ports).sample()
    expect(g.cpuPercent).toBe(60)
    expect(g.memory?.swapUsedBytes).toBe((8388604 - 4194300) * 1024)
    expect(g.disk?.freeBytes).toBe(50e9)
    expect(g.gpuPercent).toBeNull()
    expect(ports.ran).toEqual(['nvidia-smi'])
  })
  it('Solis-Core, an EC2 box whose only card is the firmware framebuffer and with no nvidia-smi, has no GPU: none, not no reading', async () => {
    expect(await createGaugeSampler(linux(SOLIS)).sample()).toMatchObject({ gpuPercent: null, gpuAbsent: true })
  })
  it('so does the Amazon VGA under a plain driver, and a server whose only display is its BMC', async () => {
    for (const uevent of [fx.UEVENT_AMAZON_VGA, fx.UEVENT_ASPEED]) expect((await createGaugeSampler(linux(oneCard(uevent))).sample()).gpuAbsent).toBe(true)
  })
  it('a box with no /sys/class/drm at all and no nvidia-smi has no GPU either', async () => {
    expect((await createGaugeSampler(linux()).sample()).gpuAbsent).toBe(true)
  })
  it('stays none on every later sample, and looks for cards once: a GPU is not plugged into a running box', async () => {
    const ports = linux(SOLIS)
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    for (const step of [4000, 60 * 60_000]) {
      ports.clock.at += step
      expect((await sampler.sample()).gpuAbsent).toBe(true)
    }
    expect(ports.listed).toEqual([DRM, `${DRM}/card0/device`, PCI])
    expect(ports.ran).toEqual(['nvidia-smi'])
  })
  it('a GPU on the bus that no driver has made a card of is no reading, never none: a g4dn before its NVIDIA driver', async () => {
    const g = await createGaugeSampler(linux(oneCard(fx.UEVENT_SIMPLEDRM, fx.PCI_G4DN_NO_DRIVER))).sample()
    expect(g).toMatchObject({ gpuPercent: null, gpuAbsent: false })
  })
  it('a PCI device whose class could not be read is no reading, and the bus is looked at again', async () => {
    let tries = 0
    const base = linux(SOLIS)
    const vga = `${PCI}/0000:00:03.0/class`
    const ports: Fake = { ...base, readText: async (path) => (path === vga && tries++ === 0 ? null : base.readText(path)) }
    const sampler = createGaugeSampler(ports)
    expect((await sampler.sample()).gpuAbsent).toBe(false)
    expect((await sampler.sample()).gpuAbsent).toBe(true)
  })
  it('an Intel laptop has a GPU whose driver keeps no busy count: no reading, never none', async () => {
    expect(await createGaugeSampler(linux(oneCard(fx.UEVENT_I915))).sample()).toMatchObject({ gpuPercent: null, gpuAbsent: false })
  })
  it('an NVIDIA card whose nvidia-smi is not installed is no reading, not none', async () => {
    expect((await createGaugeSampler(linux(oneCard(fx.UEVENT_NVIDIA))).sample()).gpuAbsent).toBe(false)
  })
  it('a card nobody recognises is no reading: unsure is never none', async () => {
    expect((await createGaugeSampler(linux(oneCard('DRIVER=panfrost\n'))).sample()).gpuAbsent).toBe(false)
  })
  it('an AMD box gets a real number: the busiest card’s gpu_busy_percent, without a child', async () => {
    const ports = linux(twoAmd({ [BUSY0]: '7\n', [BUSY1]: '64\n' }))
    expect(await createGaugeSampler(ports).sample()).toMatchObject({ gpuPercent: 64, gpuAbsent: false })
    expect(ports.listed).not.toContain(`${DRM}/card0-DP-1/device`)
    expect(ports.ran).toEqual(['nvidia-smi'])
  })
  it('a box with an AMD card and an NVIDIA one reads the busier of the two', async () => {
    const ports = linux({ ...twoAmd({ [BUSY0]: '7\n', [BUSY1]: '7\n' }), answers: { 'nvidia-smi': ok(fx.NVIDIA_SMI_ONE) } })
    expect((await createGaugeSampler(ports).sample()).gpuPercent).toBe(37)
  })
  it('a counting card whose file could not be read is no reading, and rests like a GPU tool that failed', async () => {
    const reads: string[] = []
    const base = linux(twoAmd({}))
    const ports: Fake = { ...base, readText: async (path) => (path.endsWith('gpu_busy_percent') ? (reads.push(path), null) : base.readText(path)) }
    const sampler = createGaugeSampler(ports)
    expect(await sampler.sample()).toMatchObject({ gpuPercent: null, gpuAbsent: false })
    base.clock.at += 4000
    expect((await sampler.sample()).gpuAbsent).toBe(false)
    expect(reads).toEqual([BUSY0, BUSY1])
    base.clock.at += GAUGE_GPU_COOL_MS
    await sampler.sample()
    expect(reads).toHaveLength(4)
  })
  it('a listing that failed is not taken for no GPU: it is no reading, and the cards are looked for again', async () => {
    const amd = twoAmd({ [BUSY0]: '12\n', [BUSY1]: '5\n' })
    let tries = 0
    const listDir = async (path: string): Promise<readonly string[] | 'missing' | 'failed'> => {
      if (path === DRM && tries++ === 0) return 'failed'
      return amd.dirs[path as keyof typeof amd.dirs] ?? 'missing'
    }
    const sampler = createGaugeSampler(linux({ ...amd, listDir }))
    expect(await sampler.sample()).toMatchObject({ gpuPercent: null, gpuAbsent: false })
    expect(await sampler.sample()).toMatchObject({ gpuPercent: 12, gpuAbsent: false })
  })
  it('a card whose uevent could not be read is no reading, and is asked about again', async () => {
    let tries = 0
    const base = linux(SOLIS)
    const uevent = `${DRM}/card0/device/uevent`
    const ports: Fake = { ...base, readText: async (path) => (path === uevent && tries++ === 0 ? null : base.readText(path)) }
    const sampler = createGaugeSampler(ports)
    expect((await sampler.sample()).gpuAbsent).toBe(false)
    expect((await sampler.sample()).gpuAbsent).toBe(true)
  })
  it('an nvidia-smi that is there but would not say is no reading, not none', async () => {
    for (const answer of [ok(fx.NVIDIA_SMI_NA), { stdout: null, failure: 'timeout' as const }, { stdout: null, failure: 'failed' as const }]) {
      const g = await createGaugeSampler(linux({ ...SOLIS, answers: { 'nvidia-smi': answer } })).sample()
      expect(g).toMatchObject({ gpuPercent: null, gpuAbsent: false })
    }
  })
  it('a GPU image on a CPU instance, where nvidia-smi says no devices were found, has no GPU', async () => {
    const g = await createGaugeSampler(linux({ ...SOLIS, answers: { 'nvidia-smi': ok(fx.NVIDIA_SMI_NO_DEVICES) } })).sample()
    expect(g).toMatchObject({ gpuPercent: null, gpuAbsent: true })
  })
  it('a counter file that hangs costs the GPU gauge, and is not read again while it is still out', async () => {
    vi.useFakeTimers()
    try {
      const reads: string[] = []
      const base = linux(twoAmd({}))
      const readText = async (path: string): Promise<string | null> => {
        if (!path.endsWith('gpu_busy_percent')) return base.readText(path)
        reads.push(path)
        return new Promise<never>(() => undefined)
      }
      const sampler = createGaugeSampler({ ...base, readText })
      for (let i = 0; i < 2; i++) {
        const pending = sampler.sample()
        await vi.advanceTimersByTimeAsync(GAUGE_CHILD_TIMEOUT_MS + 1)
        expect(await pending).toMatchObject({ gpuPercent: null, gpuAbsent: false })
      }
      expect(reads).toEqual([BUSY0])
    } finally {
      vi.useRealTimers()
    }
  })
  it('reads nvidia-smi when it is there', async () => {
    const g = await createGaugeSampler(linux({ answers: { 'nvidia-smi': ok(fx.NVIDIA_SMI_TWO) } })).sample()
    expect(g.gpuPercent).toBe(88)
  })
  it('a box with no nvidia-smi is asked once, not every sample', async () => {
    const ports = linux()
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at += 4000
    await sampler.sample()
    ports.clock.at += 60 * 60_000
    await sampler.sample()
    expect(ports.ran).toEqual(['nvidia-smi'])
  })
  it('no /proc is no reading, not a crash', async () => {
    const g = await createGaugeSampler(linux({ readText: async () => null })).sample()
    expect(g.cpuPercent).toBeNull()
    expect(g.memory).toBeNull()
  })
})

describe('on Windows', () => {
  it('degrades to what os gives: CPU, memory, disk; no swap, no GPU, no child', async () => {
    const ports = fake({ platform: 'win32', home: 'C:\\Users\\owner' })
    const g = await createGaugeSampler(ports).sample()
    expect(g.cpuPercent).toBe(50)
    expect(g.memory).toEqual({ usedBytes: 15 * GB, totalBytes: 16 * GB, swapUsedBytes: null, kernelLevel: null })
    expect(g.disk).not.toBeNull()
    expect(g.gpuPercent).toBeNull()
    expect(g.gpuAbsent).toBe(false)
    expect(ports.ran).toEqual([])
  })
})

describe('when the machine will not answer', () => {
  it('a GPU child that timed out is left alone for a while: forking into a stall makes it worse', async () => {
    const ports = mac({ answers: { sysctl: ok(fx.SYSCTL_STORM), ioreg: { stdout: null, failure: 'timeout' } } })
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at += 4000
    await sampler.sample()
    expect(ports.ran.filter((c) => c === 'ioreg')).toHaveLength(1)
    ports.clock.at += GAUGE_GPU_COOL_MS
    await sampler.sample()
    expect(ports.ran.filter((c) => c === 'ioreg')).toHaveLength(2)
  })
  it('a memory child that timed out is asked again: that is the gauge the owner came for', async () => {
    const ports = mac({ answers: { sysctl: { stdout: null, failure: 'timeout' }, ioreg: ok(fx.IOREG_APPLE) } })
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at += 4000
    await sampler.sample()
    expect(ports.ran.filter((c) => c === 'sysctl')).toHaveLength(2)
  })
  it('a disk that will not answer costs its own gauge and no more', async () => {
    vi.useFakeTimers()
    try {
      const pending = createGaugeSampler(mac({ statfs: () => new Promise(() => undefined) })).sample()
      await vi.advanceTimersByTimeAsync(GAUGE_CHILD_TIMEOUT_MS + 1)
      const g = await pending
      expect(g.disk).toBeNull()
      expect(g.gpuPercent).toBe(23)
    } finally {
      vi.useRealTimers()
    }
  })
  it('a volume that hangs holds one thread, not one per sample: the pool is main’s too', async () => {
    vi.useFakeTimers()
    try {
      const statfs = vi.fn(() => new Promise<never>(() => undefined))
      const ports = mac({ statfs })
      const sampler = createGaugeSampler(ports)
      for (let i = 0; i < 3; i++) {
        const pending = sampler.sample()
        await vi.advanceTimersByTimeAsync(GAUGE_CHILD_TIMEOUT_MS + 1)
        expect((await pending).disk).toBeNull()
        ports.clock.at += 4000
      }
      expect(statfs).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('a volume back from a hang is asked again', async () => {
    vi.useFakeTimers()
    try {
      let release = (_: { bavail: number; blocks: number; bsize: number }): void => undefined
      const statfs = vi.fn(() => new Promise<{ bavail: number; blocks: number; bsize: number }>((resolve) => { release = resolve }))
      const sampler = createGaugeSampler(mac({ statfs }))
      const first = sampler.sample()
      await vi.advanceTimersByTimeAsync(GAUGE_CHILD_TIMEOUT_MS + 1)
      await first
      release({ bavail: 1, blocks: 2, bsize: 1 })
      await vi.advanceTimersByTimeAsync(0)
      const second = sampler.sample()
      await vi.advanceTimersByTimeAsync(GAUGE_CHILD_TIMEOUT_MS + 1)
      await second
      expect(statfs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('a GPU tool that keeps failing rests too, like one that timed out', async () => {
    const ports = fake({ platform: 'linux', answers: { 'nvidia-smi': { stdout: null, failure: 'failed' } } })
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at += 4000
    await sampler.sample()
    expect(ports.ran.filter((c) => c === 'nvidia-smi')).toHaveLength(1)
  })
  it('a GPU that answers nothing readable rests too', async () => {
    const ports = mac({ answers: { sysctl: ok(fx.SYSCTL_CALM), ioreg: ok(fx.IOREG_NO_STATISTICS) } })
    const sampler = createGaugeSampler(ports)
    await sampler.sample()
    ports.clock.at += 4000
    await sampler.sample()
    expect(ports.ran.filter((c) => c === 'ioreg')).toHaveLength(1)
  })
  it('a statfs that throws is no reading', async () => {
    const g = await createGaugeSampler(mac({ statfs: async () => { throw new Error('EIO') } })).sample()
    expect(g.disk).toBeNull()
  })
})

describe('the watch', () => {
  const stamped = (at: number): MachineGauges => ({ at, cpuPercent: 1, memory: null, disk: null, gpuPercent: null, gpuAbsent: false })
  let clock = 0
  beforeEach(() => {
    clock = 1000
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('samples nothing until somebody reads', async () => {
    vi.useFakeTimers()
    const sample = vi.fn(async () => stamped(clock))
    createGaugeWatch({ sample }, { now: () => clock })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sample).not.toHaveBeenCalled()
  })
  it('stops the moment nobody reads: no timer of its own survives a read', async () => {
    vi.useFakeTimers()
    const sample = vi.fn(async () => stamped(clock))
    const watch = createGaugeWatch({ sample }, { now: () => clock })
    await watch.read()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sample).toHaveBeenCalledTimes(1)
  })
  it('two watchers inside the window share one sample', async () => {
    const sample = vi.fn(async () => stamped(clock))
    const watch = createGaugeWatch({ sample }, { now: () => clock })
    const first = await watch.read()
    clock += GAUGE_MIN_AGE_MS - 1
    expect(await watch.read()).toBe(first)
    expect(sample).toHaveBeenCalledTimes(1)
  })
  it('a read past the window samples again', async () => {
    const sample = vi.fn(async () => stamped(clock))
    const watch = createGaugeWatch({ sample }, { now: () => clock })
    await watch.read()
    clock += GAUGE_MIN_AGE_MS
    await watch.read()
    expect(sample).toHaveBeenCalledTimes(2)
  })
  it('reads during a slow sample join it: never two samples, so never two children', async () => {
    let finish = (_: MachineGauges): void => undefined
    const sample = vi.fn(() => new Promise<MachineGauges>((resolve) => { finish = resolve }))
    const watch = createGaugeWatch({ sample }, { now: () => clock })
    const both = Promise.all([watch.read(), watch.read(), watch.read()])
    expect(sample).toHaveBeenCalledTimes(1)
    finish(stamped(clock))
    const [a, b, c] = await both
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
  it('a clock set back does not pin the last reading: its age is not negative youth', async () => {
    const sample = vi.fn(async () => stamped(clock))
    const watch = createGaugeWatch({ sample }, { now: () => clock })
    await watch.read()
    clock -= 3_600_000
    await watch.read()
    expect(sample).toHaveBeenCalledTimes(2)
  })
  it('a sample that never ends cannot hold every later read: the reader hears, and the next read starts over', async () => {
    vi.useFakeTimers()
    const sample = vi.fn<() => Promise<MachineGauges>>()
    sample.mockReturnValueOnce(new Promise(() => undefined))
    sample.mockResolvedValueOnce(stamped(clock))
    const watch = createGaugeWatch({ sample }, { now: () => clock })
    const stuck = expect(watch.read()).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(GAUGE_SAMPLE_DEADLINE_MS + 1)
    await stuck
    await expect(watch.read()).resolves.toMatchObject({ cpuPercent: 1 })
  })
  it('a sample that threw leaves the next read free to try', async () => {
    const sample = vi.fn<() => Promise<MachineGauges>>()
    sample.mockRejectedValueOnce(new Error('no'))
    sample.mockResolvedValueOnce(stamped(clock))
    const watch = createGaugeWatch({ sample }, { now: () => clock })
    await expect(watch.read()).rejects.toThrow('no')
    await expect(watch.read()).resolves.toMatchObject({ cpuPercent: 1 })
  })
})

describe('the child runner', () => {
  it('hands back what the child printed', async () => {
    expect(await runGaugeChild('/bin/echo', ['hello'])).toEqual({ stdout: 'hello\n', failure: null })
  })
  it('keeps what answered when the child exits non-zero: an unknown oid must not cost the rest', async () => {
    const answer = await runGaugeChild('/bin/sh', ['-c', 'echo vm.swapusage: x; exit 1'])
    expect(answer).toEqual({ stdout: 'vm.swapusage: x\n', failure: null })
  })
  it('keeps nvidia-smi’s words when it exits 6 with no devices: that is how a GPU image says there is no card', async () => {
    const answer = await runGaugeChild('/bin/sh', ['-c', 'echo "No devices were found"; exit 6'])
    expect(answer).toEqual({ stdout: 'No devices were found\n', failure: null })
  })
  it('names a missing binary, so it is not asked again', async () => {
    expect(await runGaugeChild('/no/such/gauge-binary', [])).toEqual({ stdout: null, failure: 'missing' })
  })
  it('ends at its deadline even when a grandchild holds the pipes open: execFile’s callback waits for them', async () => {
    const started = Date.now()
    const answer = await runGaugeChild('/bin/sh', ['-c', 'sleep 3 & exec sleep 3'], 100)
    expect(answer).toEqual({ stdout: null, failure: 'timeout' })
    expect(Date.now() - started).toBeLessThan(100 + GAUGE_CHILD_GRACE_MS + 800)
  })
  it('a child SIGKILL cannot end is not forked again until it has gone', async () => {
    vi.useFakeTimers()
    try {
      const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null })
      const exec = vi.fn(() => child)
      const first = runGaugeChild('stuck-tool', [], 100, exec as never)
      await vi.advanceTimersByTimeAsync(100 + GAUGE_CHILD_GRACE_MS + 1)
      expect(await first).toEqual({ stdout: null, failure: 'timeout' })
      expect(await runGaugeChild('stuck-tool', [], 100, exec as never)).toEqual({ stdout: null, failure: 'timeout' })
      expect(exec).toHaveBeenCalledTimes(1)
      child.emit('exit')
      void runGaugeChild('stuck-tool', [], 100, exec as never)
      expect(exec).toHaveBeenCalledTimes(2)
      child.emit('exit')
      await vi.advanceTimersByTimeAsync(100 + GAUGE_CHILD_GRACE_MS + 1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('kills a child past its timeout, and ends even if the child ignores SIGTERM', async () => {
    const started = Date.now()
    const answer = await runGaugeChild('/bin/sh', ['-c', 'trap "" TERM; exec sleep 30'], 100)
    expect(answer).toEqual({ stdout: null, failure: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('the source', () => {
  it('holds no synchronous fork or read: main must never wait on the machine', () => {
    for (const file of ['src/main/machine-gauges.ts', 'src/main/machine-gauges-parse.ts', 'src/main/fleet/gauges-route.ts']) {
      const code = readFileSync(file, 'utf8')
      expect(code).not.toMatch(/\b(execSync|execFileSync|spawnSync|readFileSync|statfsSync|statSync)\b/)
    }
  })
  it('has no clock of its own: the readers are the clock', () => {
    const code = readFileSync('src/main/machine-gauges.ts', 'utf8')
    expect(code).not.toMatch(/setInterval/)
  })
})
