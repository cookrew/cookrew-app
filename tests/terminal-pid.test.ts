import { describe, expect, it, vi } from 'vitest'
import { endPane } from '../src/main/pane-end'
import { processFact, type ProcessFact } from '../src/main/process-facts'
import { terminalPid, type RememberedPid, type TerminalPidDeps } from '../src/main/terminal-pid'

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
