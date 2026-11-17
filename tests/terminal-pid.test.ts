import { describe, expect, it, vi } from 'vitest'
import { endPane } from '../src/main/pane-end'
import { processFact, type ProcessFact } from '../src/main/process-facts'
import { childJudge, terminalPid, type OwnChild, type RememberedPid, type TerminalPidDeps } from '../src/main/terminal-pid'

/**
 * The pane is gone from its backend at once and its process ignores the hangup:
 * the case where endPane reaches for a signal. What it may signal is the question.
 */
async function endWith(over: Partial<TerminalPidDeps>) {
  const kill = vi.fn()
  let remembered: RememberedPid | undefined = over.remembered?.()
  const root = terminalPid({
    remembered: () => remembered,
    forget: () => (remembered = undefined),
    panePid: () => 4242,
    fact: async () => ({ state: 'running', started: 'Tue Nov 17 10:00:00 2026' }),
    taken: () => true,
    kill,
    ...over
  })
  let clock = 0
  const end = await endPane(
    {
      pid: () => root.pid(),
      close: () => undefined,
      exists: () => false,
      alive: (pid) => root.alive(pid),
      signal: (pid, signal) => root.signal(pid, signal),
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock
    },
    1000
  )
  return { end, kill, identity: root.identity() }
}

describe('a terminal root process is signalled only once its start time names it', () => {
  it('POSIX: a named process that outlives its pane is ended, TERM then KILL', async () => {
    const { kill, identity } = await endWith({})
    expect(identity).toBe('Tue Nov 17 10:00:00 2026')
    expect(kill.mock.calls).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL']
    ])
  })

  it('WINDOWS: no process can be named, so the bare pid is never signalled and the end goes unconfirmed', async () => {
    // processFact itself, with the platform injected: there is no POSIX ps to name it.
    const { end, kill, identity } = await endWith({ fact: (pid) => processFact(pid, 'win32') })
    expect(identity).toBeNull()
    expect(kill).not.toHaveBeenCalled()
    expect(end).toMatchObject({ ended: false, pid: 4242 })
  })

  it('a ps that gave no answer names nothing either, on any OS', async () => {
    const { end, kill } = await endWith({ fact: async () => ({ state: 'unknown' }) })
    expect(kill).not.toHaveBeenCalled()
    expect(end.ended).toBe(false)
  })

  it('a pid remembered without a start time is looked at and never signalled', async () => {
    const facts: ProcessFact[] = [{ state: 'running', started: 'later' }]
    const { kill } = await endWith({
      remembered: () => ({ pid: 4242, started: null }),
      fact: async () => facts[0]
    })
    expect(kill).not.toHaveBeenCalled()
  })

  it('a ps that printed NO start time named nothing: an empty start is no identity, and nothing is signalled', async () => {
    const empty = await endWith({ fact: async () => ({ state: 'running', started: '' }) })
    expect(empty.identity).toBeNull()
    expect(empty.kill).not.toHaveBeenCalled()
    const remembered = await endWith({
      remembered: () => ({ pid: 4242, started: '' }),
      fact: async () => ({ state: 'running', started: '' })
    })
    expect(remembered.kill).not.toHaveBeenCalled()
  })

  it('a pid remembered WITH a start time, whose ps now gives no answer, is not signalled', async () => {
    const { kill, end } = await endWith({
      remembered: () => ({ pid: 4242, started: 'Tue Nov 17 10:00:00 2026' }),
      fact: async () => ({ state: 'unknown' })
    })
    expect(kill).not.toHaveBeenCalled()
    expect(end.ended).toBe(false)
  })

  describe('the process is read again right before EACH signal', () => {
    const NAMED = 'Tue Nov 17 10:00:00 2026'
    const rig = () => {
      let current: ProcessFact = { state: 'running', started: NAMED }
      const kill = vi.fn()
      const root = terminalPid({
        remembered: () => undefined,
        forget: () => undefined,
        panePid: () => 4242,
        fact: async () => current,
        taken: () => true,
        kill
      })
      return { root, kill, set: (fact: ProcessFact) => (current = fact) }
    }

    it('signals the process it named, while it is still that process', async () => {
      const { root, kill } = rig()
      await root.pid()
      expect(await root.alive(4242)).toBe(true)
      await root.signal(4242, 'SIGTERM')
      expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    })

    it('not when ps stops answering between the look and the signal', async () => {
      const { root, kill, set } = rig()
      await root.pid()
      expect(await root.alive(4242)).toBe(true)
      set({ state: 'unknown' })
      await root.signal(4242, 'SIGTERM')
      expect(kill).not.toHaveBeenCalled()
    })

    it('not when the pid came back as another process between the look and the signal', async () => {
      const { root, kill, set } = rig()
      await root.pid()
      expect(await root.alive(4242)).toBe(true)
      set({ state: 'running', started: 'Tue Nov 17 10:00:04 2026' })
      await root.signal(4242, 'SIGKILL')
      expect(kill).not.toHaveBeenCalled()
    })

    it('not when it ended between the look and the signal', async () => {
      const { root, kill, set } = rig()
      await root.pid()
      set({ state: 'gone' })
      await root.signal(4242, 'SIGKILL')
      expect(kill).not.toHaveBeenCalled()
    })
  })

  it('a pid that came back as another process is not signalled: it is not the one that was named', async () => {
    let started = 'Tue Nov 17 10:00:00 2026'
    const kill = vi.fn()
    const root = terminalPid({
      remembered: () => undefined,
      forget: () => undefined,
      panePid: () => 4242,
      fact: async () => ({ state: 'running', started }),
      taken: () => true,
      kill
    })
    await root.pid()
    started = 'Tue Nov 17 10:00:03 2026'
    expect(await root.alive(4242)).toBe(false)
  })
})

/**
 * A DIRECT session (node-pty's own child: Windows always, a Mac or Linux box
 * with no multiplexer) is judged by node-pty's exit, which comes from its own
 * handle on that very child, never by the pid number.
 */
describe('a terminal whose process is node-pty’s own child', () => {
  const own = (exitAfterTerminate: boolean) => {
    const child = { exited: false, terminate: vi.fn() }
    child.terminate.mockImplementation(() => {
      if (exitAfterTerminate) child.exited = true
    })
    return child
  }
  const run = async (child: OwnChild, platform: NodeJS.Platform, fact: TerminalPidDeps['fact']) => {
    const kill = vi.fn()
    const root = terminalPid({ remembered: () => undefined, forget: () => undefined, panePid: () => 4242, fact, taken: () => true, kill })
    const judge = childJudge(root, child, platform)
    let clock = 0
    const end = await endPane(
      {
        pid: () => root.pid(),
        close: () => undefined,
        exists: () => false,
        alive: judge.alive,
        signal: judge.signal,
        sleep: async (ms) => {
          clock += ms
        },
        now: () => clock
      },
      1000
    )
    return { end, kill }
  }
  const windowsFact: TerminalPidDeps['fact'] = (pid) => processFact(pid, 'win32')

  it('WINDOWS: ends when node-pty says its child exited, ended through node-pty, no pid signalled', async () => {
    const child = own(true)
    const { end, kill } = await run(child, 'win32', windowsFact)
    expect(end.ended).toBe(true)
    expect(child.terminate).toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('WINDOWS: a pid still taken (by anyone) does not keep it alive once node-pty saw the exit', async () => {
    const child = own(false)
    child.exited = true
    const { end, kill } = await run(child, 'win32', windowsFact)
    expect(end.ended).toBe(true)
    expect(kill).not.toHaveBeenCalled()
  })

  it('WINDOWS: a child that never exits is a bounded, reported failure, never a pid signal', async () => {
    const child = own(false)
    const { end, kill } = await run(child, 'win32', windowsFact)
    expect(end).toMatchObject({ ended: false, pid: 4242 })
    expect(kill).not.toHaveBeenCalled()
  })

  it('POSIX: alive by node-pty’s exit, and a signal only to the very process ps named', async () => {
    const child = own(false)
    const named: ProcessFact = { state: 'running', started: 'Tue Nov 17 10:00:00 2026' }
    const { kill } = await run(child, 'linux', async () => named)
    expect(kill.mock.calls.map((call) => call[1])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.terminate).not.toHaveBeenCalled()
  })

  it('with no own child (a multiplexer holds the pane) it is the pid rules, unchanged', async () => {
    const kill = vi.fn()
    const root = terminalPid({ remembered: () => undefined, forget: () => undefined, panePid: () => 1, fact: windowsFact, taken: () => true, kill })
    const judge = childJudge(root, null, 'win32')
    await root.pid()
    expect(await judge.alive(1)).toBe(true)
    await judge.signal(1, 'SIGKILL')
    expect(kill).not.toHaveBeenCalled()
  })
})
