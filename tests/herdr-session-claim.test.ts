import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OWNER_FILE,
  claimHerdrSession,
  confirmHerdrClaim,
  herdrSessionDir,
  inspectHerdrClaim,
  releaseHerdrClaim,
  replaceStaleClaim,
  readStartStamp,
  sameInstance,
  type ClaimDeps,
  type OwnerRecord
} from '../src/main/herdr-session-claim'
import { planHost } from '../src/main/host-claim'
import { HerdrHostMultiplexer } from '../src/main/herdr-host-multiplexer'
import { DirectMultiplexer } from '../src/main/direct-multiplexer'
import type { CommandRunner } from '../src/main/multiplexer'

// Every claim lives in a fresh temp dir — never the real
// ~/.config/herdr/sessions/cookrew, which the running app hosts the fleet in.
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hsc-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const MAIN_USERDATA = '/Users/me/Library/Application Support/cookrew'
const QA_USERDATA = '/tmp/qa-job/userdata'

/** A process table the test controls: pid -> start stamp. */
function processes(table: Record<number, string>): Pick<ClaimDeps, 'isAlive' | 'startOf'> {
  return {
    isAlive: (pid) => pid in table,
    startOf: (pid) => table[pid] ?? null
  }
}

function deps(pid: number, instance: string, table: Record<number, string>): ClaimDeps {
  return {
    pid,
    instance,
    ...processes({ ...table, [pid]: table[pid] ?? `start-${pid}` }),
    now: () => new Date('2026-11-04T00:00:00Z')
  }
}

function writeOwner(record: OwnerRecord): void {
  writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify(record))
}

function readOwner(): OwnerRecord {
  return JSON.parse(readFileSync(path.join(dir, OWNER_FILE), 'utf8')) as OwnerRecord
}

const mainOwner: OwnerRecord = { pid: 100, started: 'start-100', instance: MAIN_USERDATA, at: '2026-11-03T00:00:00Z' }

describe('herdrSessionDir — the claim sits next to the socket herdr will actually use', () => {
  it('follows HERDR_SOCKET_PATH, which herdr ranks above HERDR_SESSION and HOME', () => {
    // The 2026-09-18 shape: a QA run with its own HOME, launched from a Cookrew
    // pane, still reached the real server through the inherited socket path.
    expect(
      herdrSessionDir('cookrew', {
        HOME: '/tmp/qa-home',
        HERDR_SOCKET_PATH: '/Users/me/.config/herdr/sessions/cookrew/herdr.sock'
      })
    ).toBe('/Users/me/.config/herdr/sessions/cookrew')
  })

  it('uses XDG_CONFIG_HOME before HOME', () => {
    expect(herdrSessionDir('cookrew', { HOME: '/h', XDG_CONFIG_HOME: '/x' })).toBe('/x/herdr/sessions/cookrew')
  })

  it('falls back to ~/.config', () => {
    expect(herdrSessionDir('cookrew', { HOME: '/h' })).toBe('/h/.config/herdr/sessions/cookrew')
  })

  it('answers null when herdr itself could not locate a home', () => {
    expect(herdrSessionDir('cookrew', {})).toBeNull()
  })
})

describe('claimHerdrSession', () => {
  it('claims a session nobody owns, recording pid, start stamp and instance', () => {
    const verdict = claimHerdrSession(dir, deps(100, MAIN_USERDATA, {}))
    expect(verdict.kind).toBe('owned')
    expect(readOwner()).toMatchObject({ pid: 100, started: 'start-100', instance: MAIN_USERDATA })
  })

  it('creates the session dir when herdr has never run that session', () => {
    const fresh = path.join(dir, 'herdr', 'sessions', 'cookrew')
    expect(claimHerdrSession(fresh, deps(100, MAIN_USERDATA, {})).kind).toBe('owned')
    expect(existsSync(path.join(fresh, OWNER_FILE))).toBe(true)
  })

  it('leaves a LIVE owner from another instance alone and reports it foreign', () => {
    writeOwner(mainOwner)
    const verdict = claimHerdrSession(dir, deps(200, QA_USERDATA, { 100: 'start-100' }))
    expect(verdict).toMatchObject({ kind: 'foreign', owner: { pid: 100, instance: MAIN_USERDATA } })
    expect(readOwner()).toEqual(mainOwner)
  })

  it('takes over a claim whose pid is dead', () => {
    writeOwner(mainOwner)
    const verdict = claimHerdrSession(dir, deps(200, QA_USERDATA, {}))
    expect(verdict.kind).toBe('owned')
    expect(readOwner()).toMatchObject({ pid: 200, instance: QA_USERDATA })
  })

  it('takes over a claim whose pid was reused by another process (start stamp differs)', () => {
    writeOwner(mainOwner)
    const verdict = claimHerdrSession(dir, deps(200, QA_USERDATA, { 100: 'some-later-start' }))
    expect(verdict.kind).toBe('owned')
    expect(readOwner().pid).toBe(200)
  })

  it('treats an unreadable start stamp as live — never guesses its way into a takeover', () => {
    writeOwner(mainOwner)
    const d: ClaimDeps = { ...deps(200, QA_USERDATA, { 100: 'start-100' }), startOf: () => null }
    expect(claimHerdrSession(dir, d).kind).toBe('foreign')
  })

  it('takes over a corrupt claim file', () => {
    writeFileSync(path.join(dir, OWNER_FILE), '{not json')
    expect(claimHerdrSession(dir, deps(200, QA_USERDATA, {})).kind).toBe('owned')
    expect(readOwner().pid).toBe(200)
  })

  it('does not overwrite a live owner of the SAME instance (the single-instance lock decides)', () => {
    writeOwner(mainOwner)
    const verdict = claimHerdrSession(dir, deps(300, MAIN_USERDATA, { 100: 'start-100' }))
    expect(verdict).toMatchObject({ kind: 'same-instance', owner: { pid: 100 } })
    expect(readOwner()).toEqual(mainOwner)
  })

  it('reports its own earlier claim as owned', () => {
    claimHerdrSession(dir, deps(100, MAIN_USERDATA, {}))
    expect(claimHerdrSession(dir, deps(100, MAIN_USERDATA, {})).kind).toBe('owned')
  })
})

describe('confirmHerdrClaim — after the single-instance lock is held', () => {
  it('replaces an exiting predecessor of the same instance', () => {
    writeOwner(mainOwner)
    const verdict = confirmHerdrClaim(dir, deps(300, MAIN_USERDATA, { 100: 'start-100' }))
    expect(verdict.kind).toBe('owned')
    expect(readOwner()).toMatchObject({ pid: 300, instance: MAIN_USERDATA })
  })

  it('still never overwrites a live FOREIGN owner', () => {
    writeOwner({ ...mainOwner, instance: QA_USERDATA })
    const verdict = confirmHerdrClaim(dir, deps(300, MAIN_USERDATA, { 100: 'start-100' }))
    expect(verdict.kind).toBe('foreign')
    expect(readOwner().instance).toBe(QA_USERDATA)
  })
})

describe('releaseHerdrClaim', () => {
  it('removes our own claim', () => {
    claimHerdrSession(dir, deps(100, MAIN_USERDATA, {}))
    expect(releaseHerdrClaim(dir, deps(100, MAIN_USERDATA, {}))).toBe(true)
    expect(existsSync(path.join(dir, OWNER_FILE))).toBe(false)
  })

  it('leaves somebody else’s claim in place', () => {
    writeOwner(mainOwner)
    expect(releaseHerdrClaim(dir, deps(200, QA_USERDATA, { 100: 'start-100' }))).toBe(false)
    expect(readOwner()).toEqual(mainOwner)
  })
})

describe('inspectHerdrClaim is read-only', () => {
  it('reports free without writing anything', () => {
    expect(inspectHerdrClaim(dir, deps(100, MAIN_USERDATA, {})).kind).toBe('free')
    expect(existsSync(path.join(dir, OWNER_FILE))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// planHost: the second instance must not run ONE session command.
// ---------------------------------------------------------------------------

interface Call {
  file: string
  args: string[]
}

/** A herdr that answers --version and records everything else it is asked. */
function fakeHerdr(): CommandRunner & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args })
      return JSON.stringify({ id: 'x', result: { type: 'pane_list', panes: [] } })
    },
    runQuiet: (file, args) => {
      calls.push({ file, args })
    },
    probe: (file, args) => {
      calls.push({ file, args })
      return true
    }
  }
}

function herdrWith(runner: CommandRunner): HerdrHostMultiplexer {
  return new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: path.join(dir, 'c.toml'), runner })
}

const sessionCalls = (calls: Call[]): Call[] => calls.filter((c) => c.args[0] !== '--version')

describe('planHost — an owner claim on the herdr session', () => {
  it('a second instance that finds a live foreign owner refuses and touches nothing', () => {
    writeOwner(mainOwner)
    const runner = fakeHerdr()
    const direct = new DirectMultiplexer()
    const plan = planHost({
      candidates: [herdrWith(runner), direct],
      inert: direct,
      claimDir: dir,
      deps: deps(200, QA_USERDATA, { 100: 'start-100' })
    })
    expect(plan.refusal).toMatch(/pid 100/)
    expect(plan.refusal).toMatch(/COOKREW_MULTIPLEXER=direct/)
    expect(plan.roles.host).toBe(direct)
    expect(plan.backends).toEqual([direct])
    expect(sessionCalls(runner.calls)).toEqual([])
    expect(readOwner()).toEqual(mainOwner)
  })

  it('a free session is claimed and herdr hosts', () => {
    const runner = fakeHerdr()
    const herdr = herdrWith(runner)
    const plan = planHost({
      candidates: [herdr, new DirectMultiplexer()],
      inert: new DirectMultiplexer(),
      claimDir: dir,
      deps: deps(100, MAIN_USERDATA, {})
    })
    expect(plan.refusal).toBeNull()
    expect(plan.roles.host).toBe(herdr)
    expect(plan.claim?.kind).toBe('owned')
    expect(readOwner().pid).toBe(100)
  })

  it('a stale claim (dead pid) is taken over and herdr hosts', () => {
    writeOwner(mainOwner)
    const herdr = herdrWith(fakeHerdr())
    const plan = planHost({
      candidates: [herdr],
      inert: new DirectMultiplexer(),
      claimDir: dir,
      deps: deps(300, MAIN_USERDATA, {})
    })
    expect(plan.refusal).toBeNull()
    expect(plan.roles.host).toBe(herdr)
    expect(readOwner().pid).toBe(300)
  })

  it('an explicitly non-herdr host under a live foreign owner drops herdr from its backends', () => {
    // COOKREW_MULTIPLEXER=direct: the QA recipe. It boots, but the migration
    // pass can no longer kill the owner's panes by name through herdr.
    writeOwner(mainOwner)
    const runner = fakeHerdr()
    const direct = new DirectMultiplexer()
    const plan = planHost({
      candidates: [direct, herdrWith(runner)],
      inert: direct,
      claimDir: dir,
      deps: deps(200, QA_USERDATA, { 100: 'start-100' })
    })
    expect(plan.refusal).toBeNull()
    expect(plan.roles.host).toBe(direct)
    expect(plan.backends.map((m) => m.id)).toEqual(['direct'])
    expect(plan.claim).toBeNull()
    expect(sessionCalls(runner.calls)).toEqual([])
    expect(readOwner()).toEqual(mainOwner)
  })

  it('a non-herdr host never writes a claim (it would lock the real owner out)', () => {
    const direct = new DirectMultiplexer()
    planHost({ candidates: [direct, herdrWith(fakeHerdr())], inert: direct, claimDir: dir, deps: deps(200, QA_USERDATA, {}) })
    expect(existsSync(path.join(dir, OWNER_FILE))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Review round: the liveness probe must not be fooled.
// ---------------------------------------------------------------------------

describe('readStartStamp — the stamp must not depend on the caller', () => {
  it('runs ps with a pinned time zone and locale', () => {
    let seen: NodeJS.ProcessEnv | undefined
    const stamp = readStartStamp(42, (_file, _args, env) => {
      seen = env
      return '  Wed Nov  4 01:13:52 2026\n'
    })
    expect(stamp).toBe('Wed Nov  4 01:13:52 2026')
    // TZ=UTC or a zh_CN locale in the launching shell used to make a live
    // owner's stamp differ, which read as pid reuse -> takeover.
    expect(seen).toMatchObject({ TZ: 'UTC', LC_ALL: 'C' })
  })

  it('answers null when ps fails', () => {
    expect(
      readStartStamp(42, () => {
        throw new Error('no such process')
      })
    ).toBeNull()
  })
})

describe('claims never carry an unprovable owner', () => {
  it('a process that cannot read its own start stamp takes no claim', () => {
    const d: ClaimDeps = { ...deps(100, MAIN_USERDATA, {}), startOf: () => null }
    expect(claimHerdrSession(dir, d).kind).toBe('unknown')
    expect(existsSync(path.join(dir, OWNER_FILE))).toBe(false)
  })
})

describe('replaceStaleClaim — a stale takeover is exclusive', () => {
  it('replaces exactly the record it judged stale', () => {
    writeOwner(mainOwner)
    const judged = readFileSync(path.join(dir, OWNER_FILE), 'utf8')
    expect(replaceStaleClaim(dir, deps(300, MAIN_USERDATA, {}), judged).kind).toBe('owned')
    expect(readOwner().pid).toBe(300)
  })

  it('never displaces a claim another booter wrote after the look', () => {
    writeOwner(mainOwner)
    const judged = readFileSync(path.join(dir, OWNER_FILE), 'utf8')
    // A contender replaced the stale record between our look and our move.
    const contender: OwnerRecord = { pid: 200, started: 'start-200', instance: QA_USERDATA, at: 'x' }
    writeOwner(contender)
    const verdict = replaceStaleClaim(dir, deps(300, MAIN_USERDATA, { 200: 'start-200' }), judged)
    expect(verdict.kind).toBe('foreign')
    expect(readOwner()).toEqual(contender)
  })

  it('loses cleanly when a contender already moved the stale record away', () => {
    const judged = JSON.stringify(mainOwner)
    const contender: OwnerRecord = { pid: 200, started: 'start-200', instance: QA_USERDATA, at: 'x' }
    writeOwner(contender)
    // The file on disk is no longer `judged`; we must not take it.
    expect(replaceStaleClaim(dir, deps(300, MAIN_USERDATA, { 200: 'start-200' }), judged).kind).toBe('foreign')
    expect(readOwner()).toEqual(contender)
  })
})

describe('sameInstance — userData paths compare as the file system does', () => {
  it('is case-insensitive on macOS (cookrew vs Cookrew is one directory there)', () => {
    expect(sameInstance('/a/Application Support/cookrew', '/a/Application Support/Cookrew', 'darwin')).toBe(true)
  })

  it('is exact on Linux', () => {
    expect(sameInstance('/a/cookrew', '/a/Cookrew', 'linux')).toBe(false)
  })
})
