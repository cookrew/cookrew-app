import { describe, expect, it, vi } from 'vitest'
import { endPane, type PaneEndDeps } from '../src/main/pane-end'

// "Killed" is a claim about a process, so it takes evidence: the pane is gone
// AND its root process is gone. Box test 2, bug 1: the toast said killed while
// the counter kept counting.

interface World {
  deps: PaneEndDeps
  closes: () => number
  signals: string[]
}

function world(over: Partial<PaneEndDeps> & { pidValue?: number | null } = {}): World {
  let clock = 0
  let closes = 0
  const signals: string[] = []
  const deps: PaneEndDeps = {
    pid: () => (over.pidValue === undefined ? 4242 : over.pidValue),
    close: () => {
      closes += 1
    },
    exists: () => false,
    alive: () => false,
    signal: (_pid, signal) => {
      signals.push(signal)
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    ...over
  }
  return { deps, closes: () => closes, signals }
}

describe('endPane', () => {
  it('reads the pid BEFORE closing: afterwards the pane cannot name it', async () => {
    const order: string[] = []
    const { deps } = world({
      pid: () => {
        order.push('pid')
        return 7
      },
      close: () => {
        order.push('close')
      }
    })
    await endPane(deps)
    expect(order.slice(0, 2)).toEqual(['pid', 'close'])
  })

  it('ended: the pane is gone and its process is dead', async () => {
    const { deps } = world()
    await expect(endPane(deps)).resolves.toEqual({ ended: true, pid: 4242 })
  })

  it('a pane that takes a moment still counts, with no signal sent', async () => {
    let polls = 0
    const { deps, signals } = world({ exists: () => (polls += 1) < 3 })
    await expect(endPane(deps)).resolves.toMatchObject({ ended: true })
    expect(signals).toEqual([])
  })

  it('NOT ended while the pane survives the deadline, and it says so', async () => {
    const { deps } = world({ exists: () => true, alive: () => true })
    const result = await endPane(deps, 1000)
    expect(result).toMatchObject({ ended: false, pid: 4242 })
    expect(result.ended === false && result.reason).toMatch(/still (open|running)/)
  })

  it('asks the backend again when the first close did not take', async () => {
    const { deps, closes } = world({ exists: () => true, alive: () => false })
    await endPane(deps, 1000)
    expect(closes()).toBe(2)
  })

  it('a pane gone but its process alive is NOT ended until the process is', async () => {
    const { deps, signals } = world({ alive: () => true })
    const result = await endPane(deps, 1000)
    expect(result.ended).toBe(false)
    expect(result.ended === false && result.reason).toMatch(/process 4242/)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('a process that ignored the hangup ends on SIGTERM, and SIGKILL is never sent', async () => {
    const signals: string[] = []
    const { deps } = world({
      alive: () => signals.length === 0,
      signal: (_pid, signal) => {
        signals.push(signal)
      }
    })
    await expect(endPane(deps, 1000)).resolves.toMatchObject({ ended: true })
    expect(signals).toEqual(['SIGTERM'])
  })

  it('no signal goes out while the pane is merely slow to close: the backend owns that process', async () => {
    let polls = 0
    const signal = vi.fn()
    const { deps } = world({ exists: () => (polls += 1) < 4, alive: () => polls < 4, signal })
    await expect(endPane(deps, 10_000)).resolves.toMatchObject({ ended: true })
    expect(signal).not.toHaveBeenCalled()
  })

  it('a backend that cannot answer proves nothing: not ended', async () => {
    const { deps } = world({ exists: () => null })
    const result = await endPane(deps, 1000)
    expect(result.ended).toBe(false)
    expect(result.ended === false && result.reason).toMatch(/could not confirm/)
  })

  it('no pane and no process to name: there is nothing to end', async () => {
    const { deps, closes } = world({ pidValue: null })
    await expect(endPane(deps)).resolves.toEqual({ ended: true, pid: null })
    expect(closes()).toBe(1)
  })

  it('a pane that is there and whose process cannot be named is NOT closed: its end could never be proved', async () => {
    const { deps, closes } = world({ pidValue: null, exists: () => true })
    const result = await endPane(deps)
    expect(result.ended).toBe(false)
    expect(result.ended === false && result.reason).toMatch(/could not read/)
    expect(closes()).toBe(0)
  })

  it('a backend that cannot say, with no pid either, closes nothing and claims nothing', async () => {
    const { deps, closes } = world({ pidValue: null, exists: () => null })
    await expect(endPane(deps)).resolves.toMatchObject({ ended: false })
    expect(closes()).toBe(0)
  })

  it('a pid read that fails once is read again before giving up', async () => {
    let reads = 0
    let open = true
    const { deps } = world({
      pid: () => ((reads += 1) === 1 ? null : 7),
      exists: () => open,
      close: () => {
        open = false
      }
    })
    await expect(endPane(deps)).resolves.toEqual({ ended: true, pid: 7 })
  })

  it('a poll slower than the deadline still sends what was due before giving up', async () => {
    let clock = 0
    const signals: string[] = []
    const { deps } = world({
      alive: () => true,
      signal: (_pid, signal) => {
        signals.push(signal)
      },
      sleep: async () => {
        clock += 10_000
      },
      now: () => clock
    })
    await expect(endPane(deps, 1000)).resolves.toMatchObject({ ended: false })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('takes a backend that answers asynchronously', async () => {
    const { deps } = world({ exists: async () => false, alive: async () => false })
    await expect(endPane(deps)).resolves.toMatchObject({ ended: true })
  })

  it('a throwing backend is a failure to confirm, never an escape', async () => {
    const { deps } = world({
      close: () => {
        throw new Error('socket gone')
      },
      exists: () => null
    })
    await expect(endPane(deps, 500)).resolves.toMatchObject({ ended: false })
  })
})
