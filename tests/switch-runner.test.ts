// A workspace switch must not stop the world.
//
// Magpie, on the live app: switching workspaces made the companion answer
// NOTHING on any address for ~90 seconds. The switch handler booted every
// terminal on the incoming canvas in one synchronous loop, each boot a herdr
// attach, and the HTTP server shares that thread.
//
// Under slugs that is every phone on every workspace seeing a dead app because
// someone at the desktop changed which canvas THEY were looking at — against
// R13's promise that a switch is cheap and that a workspace keeps running while
// you look elsewhere.
//
// What is pinned: the loop yields between boots, boots stay strictly ordered,
// the attach batch still spans the whole reattach, and a switch arriving
// mid-flight supersedes cleanly instead of interleaving.

import { describe, expect, it } from 'vitest'
import { SwitchRunner, type SwitchRunnerDeps } from '../src/main/switch-runner'

interface Log {
  events: string[]
  yields: number
}

function harness(over: Partial<SwitchRunnerDeps<string, string>> = {}): {
  runner: SwitchRunner<string, string>
  log: Log
} {
  const log: Log = { events: [], yields: 0 }
  const runner = new SwitchRunner<string, string>({
    detach: (id) => log.events.push(`detach:${id}`),
    boot: (t) => log.events.push(`boot:${t}`),
    syncBrowsers: (b) => log.events.push(`browsers:${b.join(',')}`),
    onBooted: () => log.events.push('booted'),
    beginBatch: () => log.events.push('begin'),
    endBatch: () => log.events.push('end'),
    yieldToLoop: async () => {
      log.yields += 1
      await Promise.resolve()
    },
    ...over
  })
  return { runner, log }
}

const plan = (boot: string[], detach: string[] = [], browsers: string[] = []) => ({
  detach,
  boot,
  browsers
})

describe('the loop yields, so the server can answer', () => {
  it('yields once per booted terminal', async () => {
    const { runner, log } = harness()
    await runner.run(plan(['a', 'b', 'c']))
    expect(log.yields).toBe(3)
  })

  it('yields BETWEEN boots, not all at the end', async () => {
    // The distinction that matters: one 90s stall becoming N short ones with
    // gaps in between is the entire fix. Yielding only after the last boot
    // would leave the stall exactly as it was.
    const order: string[] = []
    const { runner } = harness({
      boot: (t) => order.push(`boot:${t}`),
      yieldToLoop: async () => {
        order.push('yield')
        await Promise.resolve()
      }
    })
    await runner.run(plan(['a', 'b']))
    expect(order).toEqual(['boot:a', 'yield', 'boot:b', 'yield'])
  })

  it('boots strictly in order — a PTY must exist before its inject', async () => {
    const { runner, log } = harness()
    await runner.run(plan(['first', 'second', 'third']))
    expect(log.events.filter((e) => e.startsWith('boot:'))).toEqual([
      'boot:first',
      'boot:second',
      'boot:third'
    ])
  })
})

describe('one attach batch spans the whole reattach', () => {
  it('opens once, closes once, with every boot inside', async () => {
    // Dropping this turns herdr fork cost from O(1) into O(terminals), priced
    // at 44.8x by the baseline probe.
    const { runner, log } = harness()
    await runner.run(plan(['a', 'b', 'c']))

    const begins = log.events.filter((e) => e === 'begin').length
    const firstBegin = log.events.indexOf('begin')
    const lastEnd = log.events.lastIndexOf('end')
    expect(begins).toBe(1)
    for (const [i, e] of log.events.entries()) {
      if (e.startsWith('boot:')) {
        expect(i).toBeGreaterThan(firstBegin)
        expect(i).toBeLessThan(lastEnd)
      }
    }
  })

  it('closes the batch even when a boot throws', async () => {
    const { runner, log } = harness({
      boot: (t) => {
        log.events.push(`boot:${t}`)
        throw new Error('herdr attach failed')
      }
    })
    await expect(runner.run(plan(['a']))).rejects.toThrow('herdr attach failed')
    expect(log.events.filter((e) => e === 'end').length).toBeGreaterThanOrEqual(1)
  })

  it('detaches before opening the batch', async () => {
    const { runner, log } = harness()
    await runner.run(plan(['a'], ['old-1', 'old-2']))
    expect(log.events.indexOf('detach:old-1')).toBeLessThan(log.events.indexOf('begin'))
    expect(log.events).toContain('detach:old-2')
  })
})

describe('a switch arriving mid-flight supersedes', () => {
  it('stops the older run rather than interleaving its boots', async () => {
    // Now that boots yield there is real time for a second switch to land —
    // clicking through the switcher does it routinely.
    const log: Log = { events: [], yields: 0 }
    let runner!: SwitchRunner<string, string>
    let second: Promise<void> | null = null
    let spawned = false
    runner = new SwitchRunner<string, string>({
      detach: () => undefined,
      boot: (t) => log.events.push(`boot:${t}`),
      syncBrowsers: () => undefined,
      onBooted: () => log.events.push('booted'),
      beginBatch: () => log.events.push('begin'),
      endBatch: () => log.events.push('end'),
      yieldToLoop: async () => {
        // A second switch lands during the first terminal's yield.
        if (!spawned) {
          spawned = true
          second = runner.run(plan(['new-1', 'new-2']))
        }
        await Promise.resolve()
      }
    })

    await runner.run(plan(['old-1', 'old-2', 'old-3']))
    await second

    const booted = log.events.filter((e) => e.startsWith('boot:'))
    expect(booted).toContain('boot:old-1')
    expect(booted).not.toContain('boot:old-3') // the old run stopped
    expect(booted).toContain('boot:new-1')
    expect(booted).toContain('boot:new-2')
  })

  it('the superseded run does not close the batch the new one owns', async () => {
    // The subtle half. If the old run's finally closed the batch, the new run
    // would reattach with no inventory and fork per terminal — silently, and
    // exactly on the path where a user is clicking through workspaces.
    const log: Log = { events: [], yields: 0 }
    let runner!: SwitchRunner<string, string>
    let second: Promise<void> | null = null
    let spawned = false
    runner = new SwitchRunner<string, string>({
      detach: () => undefined,
      boot: () => undefined,
      syncBrowsers: () => undefined,
      onBooted: () => undefined,
      beginBatch: () => log.events.push('begin'),
      endBatch: () => log.events.push('end'),
      yieldToLoop: async () => {
        if (!spawned) {
          spawned = true
          second = runner.run(plan(['new-1']))
        }
        await Promise.resolve()
      }
    })

    await runner.run(plan(['old-1', 'old-2']))
    await second

    // Every begin is matched, and the sequence never ends more than it began.
    let open = 0
    for (const e of log.events) {
      if (e === 'begin') open += 1
      if (e === 'end') open = Math.max(0, open - 1)
    }
    expect(open).toBe(0)
    expect(log.events.filter((e) => e === 'begin').length).toBe(2)
  })

  it('a superseded run does not sync browsers or re-report chrome', async () => {
    const log: Log = { events: [], yields: 0 }
    let runner!: SwitchRunner<string, string>
    let second: Promise<void> | null = null
    let spawned = false
    runner = new SwitchRunner<string, string>({
      detach: () => undefined,
      boot: () => undefined,
      syncBrowsers: (b) => log.events.push(`browsers:${b.join(',')}`),
      onBooted: () => log.events.push('booted'),
      beginBatch: () => undefined,
      endBatch: () => undefined,
      yieldToLoop: async () => {
        if (!spawned) {
          spawned = true
          second = runner.run(plan(['new-1'], [], ['b-new']))
        }
        await Promise.resolve()
      }
    })

    await runner.run(plan(['old-1'], [], ['b-old']))
    await second

    expect(log.events).not.toContain('browsers:b-old')
    expect(log.events).toContain('browsers:b-new')
    expect(log.events.filter((e) => e === 'booted').length).toBe(1)
  })
})

describe('degenerate plans', () => {
  it('an empty boot list closes a stale batch without opening a new one', async () => {
    const { runner, log } = harness()
    await runner.run(plan([]))
    expect(log.events.filter((e) => e === 'begin')).toEqual([])
    expect(log.events.filter((e) => e === 'end')).toHaveLength(1)
    expect(log.yields).toBe(0)
  })
})
