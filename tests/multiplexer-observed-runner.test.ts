import { afterEach, describe, expect, it } from 'vitest'
import { observedRunner, setShellObserver, shellLabel, type CommandRunner } from '../src/main/multiplexer'
import { createLoopHealth } from '../src/main/loop-health'

/**
 * THE STALL HAS A NAME. Every synchronous fork a multiplexer makes is
 * reported to the loop ledger under the command's own words, so a loop
 * maximum of seconds on /api/health says which call held the thread. What is
 * pinned: the label is words only (no pane id, no path), every runner shape
 * reports, a throw still reports, and nothing is reported when nobody is
 * listening.
 */
const runner: CommandRunner = {
  run: () => 'out',
  runQuiet: () => undefined,
  probe: () => true
}

afterEach(() => setShellObserver(null))

describe('shellLabel', () => {
  it('is the binary and two command words — never an id or a path', () => {
    expect(shellLabel('herdr', ['pane', 'read', 'w2:p7', '--source', 'recent'])).toBe('shell:herdr pane read')
    expect(shellLabel('/usr/local/bin/tmux', ['list-sessions', '-F', '#{session_name}'])).toBe('shell:tmux list-sessions')
    expect(shellLabel('herdr', ['workspace', 'create', '--cwd', '/Users/x/secret'])).toBe('shell:herdr workspace create')
    expect(shellLabel('herdr', ['pane', 'w2:p7'])).toBe('shell:herdr pane')
    expect(shellLabel('git', [])).toBe('shell:git')
  })
})

describe('observedRunner', () => {
  it('reports every shape with its label and a duration, and still answers', () => {
    const seen: { label: string; ms: number }[] = []
    setShellObserver((label, ms) => seen.push({ label, ms }))
    const observed = observedRunner(runner)
    expect(observed.run('herdr', ['pane', 'list'])).toBe('out')
    observed.runQuiet('herdr', ['pane', 'send-keys', 'w2:p1', 'enter'])
    expect(observed.probe('tmux', ['has-session', '-t', 'cookrew_x'])).toBe(true)
    expect(seen.map((s) => s.label)).toEqual(['shell:herdr pane list', 'shell:herdr pane send-keys', 'shell:tmux has-session'])
    for (const s of seen) expect(s.ms).toBeGreaterThanOrEqual(0)
  })

  it('reports a call that throws, then rethrows it', () => {
    const seen: string[] = []
    setShellObserver((label) => seen.push(label))
    const failing = observedRunner({ ...runner, run: () => { throw new Error('exit 1') } })
    expect(() => failing.run('herdr', ['pane', 'read', 'w2:p9'])).toThrow('exit 1')
    expect(seen).toEqual(['shell:herdr pane read'])
  })

  it('costs nothing when nobody is listening', () => {
    let called = 0
    const observed = observedRunner({ ...runner, run: () => { called += 1; return 'x' } })
    expect(observed.run('herdr', ['pane', 'list'])).toBe('x')
    expect(called).toBe(1)
  })

  it('lands in the loop ledger under the command’s name, beside the named loops', async () => {
    const health = createLoopHealth()
    try {
      setShellObserver((label, ms) => health.observe(label, ms))
      const observed = observedRunner({ ...runner, run: () => { const until = Date.now() + 12; while (Date.now() < until) { /* hold the thread */ } return 'slow' } })
      observed.run('herdr', ['pane', 'list'])
      observed.run('herdr', ['pane', 'list'])
      health.timed('sessionDrain', () => undefined)
      await new Promise((r) => setTimeout(r, 1100))
      const loops = health.snapshot().loops
      expect(Object.keys(loops).sort()).toEqual(['sessionDrain', 'shell:herdr pane list'])
      expect(loops['shell:herdr pane list'].count).toBe(2)
      expect(loops['shell:herdr pane list'].max).toBeGreaterThanOrEqual(10)
    } finally {
      health.stop()
    }
  })
})
