import { describe, expect, it } from 'vitest'
import {
  blocksResume,
  holderOf,
  isSessionHeldError,
  liveSessionHolders,
  planHeldSessionFork,
  type LiveSessionFs,
  type SessionHolder
} from '../src/main/claude-live-session'

/**
 * Observed on Forge, and the reason recovery "succeeded" forever without
 * working. Its session was held by a leftover `claude bg-spare` (pid 92878)
 * from a finished background job, so every resume ended at:
 *
 *   Error: Session 427aa2f7-… is currently running as a background agent (bg).
 *   Use `claude agents` to find and attach to it, or add --fork-session to
 *   branch off a copy.
 *
 * One line, then exit. The session FILE existed, so the exact-context gate
 * passed, the pty spawned, and the card showed READY / LIVE over a black void.
 */

const FORGE = '427aa2f7-c9cc-403b-abd1-84523aa10d51'
const TINKER = 'b25d2d75-7432-447e-8141-71290cfc09bb'

/** Shape-accurate ~/.claude/sessions/<pid>.json records. */
const RECORDS: Record<string, string> = {
  '92878.json': JSON.stringify({ pid: 92878, sessionId: FORGE, cwd: '/w', kind: 'bg' }),
  '1774.json': JSON.stringify({ pid: 1774, sessionId: TINKER, cwd: '/w', kind: 'interactive' }),
  // A process that has exited: its file lingers until something cleans up.
  '4242.json': JSON.stringify({ pid: 4242, sessionId: 'dead-session', kind: 'bg' })
}

function stubFs(alivePids: number[], extra: Record<string, string> = {}): LiveSessionFs {
  const files = { ...RECORDS, ...extra }
  return {
    list: () => Object.keys(files),
    read: (file) => {
      const name = file.slice(file.lastIndexOf('/') + 1)
      const body = files[name]
      if (body === undefined) throw new Error('ENOENT')
      return body
    },
    alive: (pid) => alivePids.includes(pid)
  }
}

describe('liveSessionHolders', () => {
  it('reports only sessions a LIVE process holds', () => {
    const holders = liveSessionHolders('/sessions', stubFs([92878, 1774]))
    expect(holders.map((h) => h.sessionId).sort()).toEqual([FORGE, TINKER].sort())
    expect(holders.find((h) => h.sessionId === FORGE)?.kind).toBe('bg')
  })

  it('ignores a file whose process has exited', () => {
    // These accumulate — 133 files, 8 live, on the machine this was found on.
    const holders = liveSessionHolders('/sessions', stubFs([92878]))
    expect(holders.map((h) => h.sessionId)).toEqual([FORGE])
  })

  it('reads nothing for a dead pid', () => {
    const read: string[] = []
    const fs = stubFs([92878])
    const holders = liveSessionHolders('/sessions', {
      ...fs,
      read: (file) => {
        read.push(file)
        return fs.read(file)
      }
    })
    expect(holders).toHaveLength(1)
    // Liveness is checked BEFORE the read; reading every stale file is the
    // only cost that would make this too slow to do at spawn time.
    expect(read).toHaveLength(1)
  })

  it('survives a missing directory, junk names and half-written files', () => {
    // "Cannot tell" must degrade to "no claim" — never fail a recovery.
    expect(
      liveSessionHolders('/sessions', {
        list: () => {
          throw new Error('ENOENT')
        },
        read: () => '',
        alive: () => true
      })
    ).toEqual([])

    const holders = liveSessionHolders(
      '/sessions',
      stubFs([92878, 55], { 'notes.txt': 'x', '55.json': '{"sessionId":' })
    )
    expect(holders.map((h) => h.sessionId)).toEqual([FORGE])
  })

  it('skips a record with no session id', () => {
    const holders = liveSessionHolders(
      '/sessions',
      stubFs([77], { '77.json': JSON.stringify({ pid: 77, cwd: '/w' }) })
    )
    expect(holders).toEqual([])
  })
})

describe('holderOf', () => {
  const holders: SessionHolder[] = [
    { pid: 92878, sessionId: FORGE, kind: 'bg' },
    { pid: 1774, sessionId: TINKER, kind: 'interactive' }
  ]

  it('finds the process holding a session', () => {
    expect(holderOf(FORGE, holders)?.pid).toBe(92878)
  })

  it('is null for a free session', () => {
    expect(holderOf('not-held', holders)).toBeNull()
  })

  it('does not count OUR OWN process as a foreign holder', () => {
    // On an app restart a pane whose claude is still alive holds its own
    // session; forking that would split a conversation that was never stuck.
    expect(holderOf(TINKER, holders, 1774)).toBeNull()
    expect(holderOf(TINKER, holders, 999)?.pid).toBe(1774)
  })
})

describe('planHeldSessionFork', () => {
  const holders: SessionHolder[] = [{ pid: 92878, sessionId: FORGE, kind: 'bg' }]
  const resume = `claude --permission-mode bypassPermissions --resume ${FORGE}`
  const MINTED = 'ee299bc8-f345-462f-a760-f08ea24ce2a7'
  const mint = (): string => MINTED

  it('forks a held session under an id WE choose', () => {
    // Verified against the real CLI: --resume <old> --fork-session
    // --session-id <new> writes the copy under <new>. Naming it ourselves is
    // what lets the node bind the copy at launch instead of discovering it.
    const plan = planHeldSessionFork(resume, FORGE, holders, mint)
    expect(plan.command).toBe(`${resume} --fork-session --session-id ${MINTED}`)
    expect(plan.forkedTo).toBe(MINTED)
  })

  it('leaves a free session alone and mints nothing', () => {
    let minted = 0
    const plan = planHeldSessionFork(`claude --resume ${TINKER}`, TINKER, holders, () => {
      minted++
      return MINTED
    })
    expect(plan.command).toBe(`claude --resume ${TINKER}`)
    expect(plan.forkedTo).toBeNull()
    expect(minted).toBe(0)
  })

  it('leaves a fresh-session launch alone — there is nothing to fork', () => {
    const fresh = `claude --session-id ${FORGE}`
    expect(planHeldSessionFork(fresh, FORGE, holders, mint)).toEqual({
      command: fresh,
      forkedTo: null
    })
  })

  it('does not fork a command that already forks', () => {
    const already = `${resume} --fork-session`
    expect(planHeldSessionFork(already, FORGE, holders, mint)).toEqual({
      command: already,
      forkedTo: null
    })
  })

  it('is a no-op when nothing is held at all', () => {
    expect(planHeldSessionFork(resume, FORGE, [], mint)).toEqual({
      command: resume,
      forkedTo: null
    })
  })

  it('does not fork because OUR OWN process holds the session', () => {
    const mine: SessionHolder[] = [{ pid: 4242, sessionId: FORGE, kind: 'interactive' }]
    expect(planHeldSessionFork(resume, FORGE, mine, mint, 4242).forkedTo).toBeNull()
  })

  it('does not fork for an INTERACTIVE holder, even a foreign one', () => {
    // A pane surviving an app restart holds its own session while tmux
    // reattaches it. Forking there splits a healthy conversation in two on
    // every restart — the exact failure that pointed Forge at a session file
    // nobody ever wrote.
    const pane: SessionHolder[] = [{ pid: 47324, sessionId: FORGE, kind: 'interactive' }]
    expect(planHeldSessionFork(resume, FORGE, pane, mint).forkedTo).toBeNull()
  })
})

describe('blocksResume', () => {
  it('is true only for a background holder', () => {
    expect(blocksResume({ pid: 1, sessionId: FORGE, kind: 'bg' })).toBe(true)
    expect(blocksResume({ pid: 1, sessionId: FORGE, kind: 'interactive' })).toBe(false)
    expect(blocksResume({ pid: 1, sessionId: FORGE, kind: 'unknown' })).toBe(false)
    expect(blocksResume(null)).toBe(false)
  })
})

describe('isSessionHeldError', () => {
  it('recognises claude\u2019s own refusal, verbatim', () => {
    expect(
      isSessionHeldError(
        `Error: Session ${FORGE} is currently running as a background agent (bg). ` +
          'Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy.'
      )
    ).toBe(true)
    expect(isSessionHeldError('Session x is currently running as a terminal')).toBe(true)
  })

  it('does not fire on ordinary output', () => {
    expect(isSessionHeldError('running as expected')).toBe(false)
    expect(isSessionHeldError('')).toBe(false)
  })
})
