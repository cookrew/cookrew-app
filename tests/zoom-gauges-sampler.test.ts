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
  clock: { at: number }
  active: { now: number; peak: number }
}

function fake(over: Partial<GaugeSamplerPorts> & { answers?: Record<string, ChildAnswer>; files?: Record<string, string> } = {}): Fake {
  const { answers = {}, files = {}, ...ports } = over
  const clock = { at: 1000 }
  const active = { now: 0, peak: 0 }
  const ran: string[] = []
  let idle = 0
  return {
    ran,
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
    return fake({
      platform: 'linux',
      readText: async (path) => {
        if (path === '/proc/stat') return reads++ === 0 ? fx.PROC_STAT_A : fx.PROC_STAT_B
        return path === '/proc/meminfo' ? fx.PROC_MEMINFO : null
      },
      ...over
    })
  }
  it('reads /proc for CPU and memory, statfs for the disk, no child at all without nvidia-smi', async () => {
    const ports = linux()
    const g = await createGaugeSampler(ports).sample()
    expect(g.cpuPercent).toBe(60)
    expect(g.memory?.swapUsedBytes).toBe((8388604 - 4194300) * 1024)
    expect(g.disk?.freeBytes).toBe(50e9)
    expect(g.gpuPercent).toBeNull()
    expect(ports.ran).toEqual(['nvidia-smi'])
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
  const stamped = (at: number): MachineGauges => ({ at, cpuPercent: 1, memory: null, disk: null, gpuPercent: null })
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
    for (const file of ['src/main/machine-gauges.ts', 'src/main/machine-gauges-parse.ts', 'src/main/levels/gauges-route.ts']) {
      const code = readFileSync(file, 'utf8')
      expect(code).not.toMatch(/\b(execSync|execFileSync|spawnSync|readFileSync|statfsSync|statSync)\b/)
    }
  })
  it('has no clock of its own: the readers are the clock', () => {
    const code = readFileSync('src/main/machine-gauges.ts', 'utf8')
    expect(code).not.toMatch(/setInterval/)
  })
})
