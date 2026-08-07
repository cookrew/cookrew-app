import { describe, expect, it } from 'vitest'
import { HerdrMultiplexer, toScrollState } from '../src/main/herdr-multiplexer'
import type { CommandRunner } from '../src/main/multiplexer'

/**
 * The herdr backend is READ-ONLY by measurement, not by omission — these tests
 * pin that, because the dangerous failure is a future change quietly making it
 * selectable as a terminal host.
 */

const PANE_LIST = JSON.stringify({
  id: 'cli:pane:list',
  result: {
    type: 'pane_list',
    panes: [
      {
        pane_id: 'w3:p1',
        terminal_id: 'term_abc',
        agent: 'Claude Code',
        agent_status: 'working',
        scroll: { offset_from_bottom: 0, max_offset_from_bottom: 194, viewport_rows: 47 }
      },
      { pane_id: 'w3:p2', terminal_id: 'term_def', agent_status: 'unknown', scroll: null }
    ]
  }
})

function runner(responses: Record<string, string>, throwOn: string[] = []): CommandRunner {
  const pick = (args: string[]): string => {
    const key = args.join(' ')
    if (throwOn.some((t) => key.includes(t))) throw new Error(`boom: ${key}`)
    const match = Object.keys(responses).find((k) => key.includes(k))
    if (match === undefined) throw new Error(`no stub: ${key}`)
    return responses[match]
  }
  return { run: (_f, a) => pick(a), runQuiet: () => undefined, probe: () => true }
}

const RUNNING = 'client:\n  version: 0.8.0\n\nserver:\n  status: running\n'

function mux(responses: Record<string, string> = {}, throwOn: string[] = []): HerdrMultiplexer {
  return new HerdrMultiplexer({
    runner: runner({ status: RUNNING, 'pane list': PANE_LIST, ...responses }, throwOn)
  })
}

describe('capabilities — the load-bearing declaration', () => {
  it('declares that it CANNOT host a terminal', () => {
    // Measured: `herdr session attach` returns 97,553 bytes of TUI where tmux
    // returns 2,090 bytes of pane, and never echoes typed input.
    expect(mux().capabilities.attach).toBe(false)
  })

  it('declares no copy-mode search — the checkpoint jump has no equivalent', () => {
    expect(mux().capabilities.copyModeSearch).toBe(false)
  })

  it('THROWS rather than degrading when asked to host a terminal', () => {
    // A silent fallback would hand node-pty a TUI stream and the damage would
    // surface much later, as a scraper producing nonsense.
    expect(() => mux().attachSpawn()).toThrow(/cannot host a terminal/i)
  })
})

describe('availability', () => {
  it('requires a RUNNING server, not merely an installed binary', () => {
    expect(mux().available()).toBe(true)
    expect(
      new HerdrMultiplexer({
        runner: runner({ status: 'client:\n  version: 0.8.0\n\nserver:\n  status: not running\n' })
      }).available()
    ).toBe(false)
  })

  it('reports unavailable when the binary is absent, without throwing', () => {
    expect(new HerdrMultiplexer({ runner: runner({}, ['status']) }).available()).toBe(false)
  })

  it('probes once and caches the answer', () => {
    const calls: string[][] = []
    const m = new HerdrMultiplexer({
      runner: {
        run: (_f, a) => {
          calls.push(a)
          return RUNNING
        },
        runQuiet: () => undefined,
        probe: () => true
      }
    })
    m.available()
    m.available()
    expect(calls.filter((c) => c[0] === 'status')).toHaveLength(1)
  })
})

describe('toScrollState — herdr’s model → Cookrew’s', () => {
  it('maps offset_from_bottom to scrollRow and derives a history depth', () => {
    // history_size counts lines that scrolled OUT of the viewport, so the
    // comparable total adds the rows currently on screen.
    expect(toScrollState({ offset_from_bottom: 3, max_offset_from_bottom: 194, viewport_rows: 47 }))
      .toEqual({ scrollRow: 3, historySize: 241 })
  })

  it('is null-null when the pane reports no scroll block', () => {
    expect(toScrollState(null)).toEqual({ scrollRow: null, historySize: null })
    expect(toScrollState(undefined)).toEqual({ scrollRow: null, historySize: null })
  })

  it('tolerates a missing viewport_rows', () => {
    expect(toScrollState({ offset_from_bottom: 0, max_offset_from_bottom: 10 }).historySize).toBe(10)
  })
})

describe('reads', () => {
  it('finds a pane by terminal_id or by pane_id', () => {
    expect(mux().sessionExists('term_abc')).toBe(true)
    expect(mux().sessionExists('w3:p1')).toBe(true)
    expect(mux().sessionExists('nope')).toBe(false)
  })

  it('lists terminal ids, skipping panes without one', () => {
    expect(mux().listSessions()).toEqual(['term_abc', 'term_def'])
  })

  it('captures with recent-unwrapped — logical lines, not physical rows', () => {
    const seen: string[][] = []
    const m = new HerdrMultiplexer({
      runner: {
        run: (_f, a) => {
          seen.push(a)
          if (a.join(' ').includes('pane read')) {
            // Raw text, not the JSON envelope — 0.8.0's one exception.
            return 'line one\nline two'
          }
          return a[0] === 'status' ? RUNNING : PANE_LIST
        },
        runQuiet: () => undefined,
        probe: () => true
      }
    })
    expect(m.capture('term_abc')).toBe('line one\nline two')
    const read = seen.find((a) => a.join(' ').includes('pane read'))?.join(' ')
    expect(read).toContain('--source recent-unwrapped')
    expect(read).toContain('w3:p1')
  })

  it('returns null capture for an unknown session', () => {
    expect(mux().capture('missing')).toBeNull()
  })

  it('treats an EMPTY pane as empty, not as a failure', () => {
    // `pane read` writes raw text, so zero bytes is a legitimate answer for a
    // pane with nothing in scrollback. Parsing it as JSON turned every capture
    // into null, which downstream reads as "no signal" — silently wrong.
    const m = new HerdrMultiplexer({
      runner: {
        run: (_f, a) =>
          a.join(' ').includes('pane read') ? '' : a[0] === 'status' ? RUNNING : PANE_LIST,
        runQuiet: () => undefined,
        probe: () => true
      }
    })
    expect(m.capture('term_abc')).toBe('')
  })

  it('surfaces an error response as null rather than as data', () => {
    const m = new HerdrMultiplexer({
      runner: runner({
        status: RUNNING,
        'pane list': JSON.stringify({ id: 'x', error: { code: 'nope', message: 'no' } })
      })
    })
    expect(m.listSessions()).toEqual([])
    expect(m.sessionExists('term_abc')).toBe(false)
  })

  it('reads scroll state straight off the pane listing', () => {
    expect(mux().scrollState('term_abc')).toEqual({ scrollRow: 0, historySize: 241 })
    expect(mux().scrollState('term_def')).toEqual({ scrollRow: null, historySize: null })
  })

  it('is honest about what it has not verified', () => {
    // pane process-info exists but was never confirmed against a real agent
    // pane; null is the truthful answer and callers already degrade.
    expect(mux().panePid()).toBeNull()
    expect(mux().paneLaunch()).toBeNull()
  })

  it('never pretends to have scrolled a pane it cannot scroll', () => {
    expect(() => mux().jumpToText()).not.toThrow()
    expect(() => mux().exitCopyMode()).not.toThrow()
  })
})
