// Sol r4 P1 — the physical dispatch ledger stays bounded.
//
// The registry was append-only forever: every transition, every buried
// record and every expired tombstone stayed on disk, prune deleted only
// in-memory entries, and hydration re-parsed the whole history on every
// boot. Compaction rewrites the file down to its LIVE set — atomically
// (temp + fsync + rename, the receipts-ledger pattern), at hydrate time
// only, and a failure at any point leaves the original byte-identical.

import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  DispatchService,
  appendDispatchRecord,
  appendDispatchTombstone,
  compactDispatchRegistry,
  compactionTempPath,
  promptFingerprint,
  readDispatchRecords,
  readDispatchTombstones,
  type DispatchDeps,
  type DispatchRecord,
  type DispatchTombstone
} from '../src/main/dispatch'

// The crash simulation: rename (and, for the Sol r5 P2 tests, unlink) fails
// on demand while every other fs call passes through — a crash between
// temp-write and rename is exactly "the rename never happened". openSync,
// fsyncSync and fchmodSync are recorded pass-throughs, so the durability
// tests can assert WHICH descriptors were synced and repaired.
const crash = vi.hoisted(() => ({
  failRename: false,
  failUnlink: false,
  opened: [] as Array<{ fd: number; path: string }>,
  fsynced: [] as number[],
  fchmods: [] as Array<{ fd: number; mode: number }>
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (crash.failRename) throw new Error('simulated crash before rename landed')
      actual.renameSync(from, to)
    },
    unlinkSync: (target: string): void => {
      if (crash.failUnlink) throw new Error('simulated EPERM: stale temp cannot be removed')
      actual.unlinkSync(target)
    },
    openSync: (target: string, flags: string | number, mode?: number): number => {
      const fd = actual.openSync(target, flags as never, mode)
      crash.opened.push({ fd, path: String(target) })
      return fd
    },
    fsyncSync: (fd: number): void => {
      crash.fsynced.push(fd)
      actual.fsyncSync(fd)
    },
    fchmodSync: (fd: number, mode: number): void => {
      crash.fchmods.push({ fd, mode })
      actual.fchmodSync(fd, mode)
    }
  }
})

/** Reset the simulation between tests. */
function resetCrashSim(): void {
  crash.failRename = false
  crash.failUnlink = false
  crash.opened.length = 0
  crash.fsynced.length = 0
  crash.fchmods.length = 0
}

const PROMPT = 'Run the F2 simulation and report the counts.'
const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

const ledger = (): string =>
  path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-compact-')), 'dispatches.jsonl')

function row(over: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    id: 'dsp-1',
    agentId: 'agent-1',
    agentName: 'Forge',
    workspaceId: 'ws-1',
    state: 'submitted',
    via: 'herdr',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...over
  }
}

function tombstone(over: Partial<DispatchTombstone> = {}): DispatchTombstone {
  return {
    kind: 'tombstone',
    scope: '\u0000key-a',
    dispatchId: 'dsp-old',
    state: 'done',
    promptHash: promptFingerprint(PROMPT),
    closedAt: NOW - DAY,
    ...over
  }
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    resolveAgent: (id) => (id === 'agent-1' ? { name: 'Forge', workspaceId: 'ws-1' } : null),
    sessionNameFor: (id) => `cookrew_${id}`,
    sessionExists: () => true,
    capture: () => 'idle\n> ',
    promptAgent: async () => 'done',
    noteDispatch: () => true,
    beginWork: () => true,
    endWork: () => undefined,
    persist: () => true,
    newId: () => 'dsp-1',
    now: () => NOW,
    ...over
  }
}

/** A service wired to a real registry file, compaction included. */
function onDisk(file: string, over: Partial<DispatchDeps> = {}): DispatchService {
  return new DispatchService(
    deps({
      persist: (record) => appendDispatchRecord(file, record),
      persistTombstone: (t) => appendDispatchTombstone(file, t),
      loadRecords: () => readDispatchRecords(file),
      loadTombstones: () => readDispatchTombstones(file),
      compactRegistry: () => compactDispatchRegistry(file, NOW),
      ...over
    })
  )
}

const lineCount = (file: string): number =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).length

describe('compactDispatchRegistry — the live set survives, the dead weight goes', () => {
  afterEach(() => {
    resetCrashSim()
    vi.restoreAllMocks()
  })

  it('rewrites superseded transitions down to the last row per id, preserved byte-exactly on reload', () => {
    const file = ledger()
    // Three transitions for one id: two dead lines out of three (> 50%).
    appendDispatchRecord(file, row({ state: 'submitted' }))
    appendDispatchRecord(file, row({ state: 'running', updatedAt: NOW - 900 }))
    appendDispatchRecord(file, row({ state: 'done', updatedAt: NOW - 800, turnIndex: 4, turnUuid: 'uuid-4' }))
    const liveBefore = readDispatchRecords(file).at(-1)

    const result = compactDispatchRegistry(file, NOW)
    expect(result).toMatchObject({ rewritten: true, liveLines: 1, droppedLines: 2 })
    expect(lineCount(file)).toBe(1)
    // The surviving line reloads to EXACTLY the row hydration would have
    // derived from the full history.
    const [reloaded] = readDispatchRecords(file)
    expect(reloaded).toEqual(liveBefore)
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(liveBefore)}\n`)
  })

  it('preserves open records, in-retention closed records and unexpired tombstones; drops buried records and expired tombstones', () => {
    const file = ledger()
    // An OPEN record — never dropped, however old.
    appendDispatchRecord(
      file,
      row({ id: 'dsp-open', state: 'running', createdAt: NOW - 60 * DAY, updatedAt: NOW - 60 * DAY })
    )
    // A recent closed record — within the 7-day retention.
    appendDispatchRecord(file, row({ id: 'dsp-recent', state: 'done', updatedAt: NOW - DAY }))
    // An aged closed record already BURIED by its (unexpired) tombstone.
    appendDispatchRecord(
      file,
      row({
        id: 'dsp-old',
        state: 'done',
        updatedAt: NOW - 30 * DAY,
        idempotencyKey: 'key-a',
        promptHash: promptFingerprint(PROMPT)
      })
    )
    appendDispatchTombstone(file, tombstone({ scope: '\u0000key-a', closedAt: NOW - 30 * DAY }))
    // An EXPIRED tombstone and the record it buried: both are dead weight.
    appendDispatchRecord(
      file,
      row({ id: 'dsp-ancient', state: 'failed', updatedAt: NOW - 120 * DAY, idempotencyKey: 'key-b' })
    )
    appendDispatchTombstone(
      file,
      tombstone({ scope: '\u0000key-b', dispatchId: 'dsp-ancient', state: 'failed', closedAt: NOW - 120 * DAY })
    )
    // A KEYLESS closed record past retention: droppable outright.
    appendDispatchRecord(file, row({ id: 'dsp-stale', state: 'done', updatedAt: NOW - 30 * DAY }))

    const result = compactDispatchRegistry(file, NOW)
    expect(result.rewritten).toBe(true)
    expect(readDispatchRecords(file).map((r) => r.id).sort()).toEqual(['dsp-open', 'dsp-recent'])
    const stones = readDispatchTombstones(file)
    expect(stones).toHaveLength(1)
    expect(stones[0]).toMatchObject({ scope: '\u0000key-a', state: 'done' })

    // The compacted registry answers exactly as the full one did: the open
    // row hydrates (interrupted), the buried key still replays honestly.
    const service = onDisk(file)
    expect(service.get('dsp-open')?.state).toBe('interrupted')
    expect(service.get('dsp-recent')?.state).toBe('done')
    return service
      .dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
      .then((replay) => {
        expect(replay.status).toBe(200)
        expect(replay.body).toMatchObject({ dispatchId: 'dsp-old', replay: true, tombstone: true })
      })
  })

  it('keeps a KEYED aged record whose burial never landed — the key promise has no other carrier', () => {
    const file = ledger()
    appendDispatchRecord(file, row({ state: 'submitted' }))
    appendDispatchRecord(
      file,
      row({ id: 'dsp-1', state: 'done', updatedAt: NOW - 30 * DAY, idempotencyKey: 'key-unburied' })
    )
    const result = compactDispatchRegistry(file, NOW)
    expect(result.rewritten).toBe(true) // the superseded transition still goes
    expect(readDispatchRecords(file).map((r) => r.id)).toEqual(['dsp-1'])
    expect(readDispatchRecords(file)[0].idempotencyKey).toBe('key-unburied')
  })

  it('leaves an all-live file untouched — below both thresholds, nothing to drop', () => {
    const file = ledger()
    appendDispatchRecord(file, row({ id: 'dsp-a', state: 'done', updatedAt: NOW - DAY }))
    appendDispatchRecord(file, row({ id: 'dsp-b', state: 'done', updatedAt: NOW - DAY }))
    const before = readFileSync(file, 'utf8')
    const result = compactDispatchRegistry(file, NOW)
    expect(result.rewritten).toBe(false)
    expect(result.droppedLines).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('spares a small file with minority dead weight — under 50% and under the byte floor', () => {
    const file = ledger()
    // One dead line out of three (33%): not worth a rewrite yet.
    appendDispatchRecord(file, row({ id: 'dsp-a', state: 'running', updatedAt: NOW - 2000 }))
    appendDispatchRecord(file, row({ id: 'dsp-a', state: 'done', updatedAt: NOW - DAY }))
    appendDispatchRecord(file, row({ id: 'dsp-b', state: 'done', updatedAt: NOW - DAY }))
    const before = readFileSync(file, 'utf8')
    const result = compactDispatchRegistry(file, NOW)
    expect(result).toMatchObject({ rewritten: false, liveLines: 2, droppedLines: 1 })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('an absent registry compacts to a no-op', () => {
    expect(compactDispatchRegistry(path.join(tmpdir(), 'no-such-registry.jsonl'), NOW)).toEqual({
      rewritten: false,
      liveLines: 0,
      droppedLines: 0
    })
  })

  it('the rewritten registry stays owner-only (0600)', () => {
    const file = ledger()
    appendDispatchRecord(file, row({ state: 'submitted' }))
    appendDispatchRecord(file, row({ state: 'running', updatedAt: NOW - 900 }))
    appendDispatchRecord(file, row({ state: 'done', updatedAt: NOW - 800 }))
    expect(compactDispatchRegistry(file, NOW).rewritten).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('hydrate-time compaction keeps the file bounded across restarts', () => {
  afterEach(() => {
    resetCrashSim()
    vi.restoreAllMocks()
  })

  it('repeated hydrate cycles converge on the live set and stay there', async () => {
    const file = ledger()
    // Life 1: real work — accept (submitted), deliver (running), close (done)
    // = three lines for one dispatch.
    const first = onDisk(file)
    const accepted = await first.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    await first.settled(String((accepted.body as { dispatchId: string }).dispatchId))
    first.completeTurn('dsp-1', { turnIndex: 1, uuid: 'uuid-1' })
    expect(lineCount(file)).toBe(3)

    // Every later life hydrates, compacts, and leaves ONE line — restart
    // parsing is bounded by the live set, not by lifetime churn.
    onDisk(file)
    expect(lineCount(file)).toBe(1)
    const stable = lineCount(file)
    onDisk(file)
    onDisk(file)
    onDisk(file)
    expect(lineCount(file)).toBe(stable)
    // And the surviving row is the settled dispatch, key intact.
    const last = onDisk(file)
    expect(last.get('dsp-1')).toMatchObject({ state: 'done', turnIndex: 1, turnUuid: 'uuid-1' })
    const replay = await last.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1', replay: true })
  })

  it('a memory-only service (no compactRegistry dep) hydrates exactly as before', () => {
    const service = new DispatchService(deps({ loadRecords: () => [row({ state: 'done' })] }))
    expect(service.get('dsp-1')?.state).toBe('done')
  })

  it('a throwing compaction hook is loud but never takes hydration down', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const service = new DispatchService(
      deps({
        loadRecords: () => [row({ state: 'done' })],
        compactRegistry: () => {
          throw new Error('disk went away')
        }
      })
    )
    expect(service.get('dsp-1')?.state).toBe('done')
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/compaction hook/i)
  })
})

describe('crash safety — the original registry survives anything short of the rename', () => {
  afterEach(() => {
    resetCrashSim()
    vi.restoreAllMocks()
  })

  it('the temp path is distinct from the registry, in the same directory', () => {
    const file = ledger()
    const tmp = compactionTempPath(file)
    expect(tmp).not.toBe(file)
    expect(path.dirname(tmp)).toBe(path.dirname(file))
  })

  it('a crash between temp-write and rename leaves the original byte-identical', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const file = ledger()
    appendDispatchRecord(file, row({ state: 'submitted' }))
    appendDispatchRecord(file, row({ state: 'running', updatedAt: NOW - 900 }))
    appendDispatchRecord(file, row({ state: 'done', updatedAt: NOW - 800 }))
    const before = readFileSync(file, 'utf8')

    crash.failRename = true
    const result = compactDispatchRegistry(file, NOW)
    expect(result.rewritten).toBe(false)
    // The registry never changed: the rewrite existed only at the temp path,
    // which the failure path cleans up rather than leaving to confuse reads.
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readDispatchRecords(file)).toHaveLength(3)
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/compaction failed/i)

    // The next (healthy) attempt succeeds over the same file.
    crash.failRename = false
    expect(compactDispatchRegistry(file, NOW).rewritten).toBe(true)
    expect(lineCount(file)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Sol r5 P2 — durable across power loss, and stale temps cannot leak modes.
// ---------------------------------------------------------------------------

describe('compaction durability and temp-permission repair (Sol r5 P2)', () => {
  afterEach(() => {
    resetCrashSim()
    vi.restoreAllMocks()
  })

  /** A registry with enough dead weight that compaction must rewrite. */
  const compactable = (): string => {
    const file = ledger()
    appendDispatchRecord(file, row({ state: 'submitted' }))
    appendDispatchRecord(file, row({ state: 'running', updatedAt: NOW - 900 }))
    appendDispatchRecord(file, row({ state: 'done', updatedAt: NOW - 800 }))
    return file
  }

  it('a pre-existing 0644 temp is repaired before the rename — the registry stays 0600', () => {
    // A crashed run's leftover .compacting with a permissive mode: openSync's
    // create-mode cannot fix it (mode applies at CREATE only), so without the
    // remove-then-fchmod pair the rename installs a world-readable registry.
    const file = compactable()
    const tmp = compactionTempPath(file)
    writeFileSync(tmp, 'stale rewrite from a crashed compaction\n')
    chmodSync(tmp, 0o644)

    const result = compactDispatchRegistry(file, NOW)
    expect(result.rewritten).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(lineCount(file)).toBe(1)
  })

  it('repairs the mode on the DESCRIPTOR when the stale temp cannot be removed', () => {
    // The unlink path is blocked (EPERM): the rewrite proceeds over the
    // stale inode, and fchmod on the open fd is what repairs its 0644 before
    // that inode is renamed into place.
    const file = compactable()
    const tmp = compactionTempPath(file)
    writeFileSync(tmp, 'stale rewrite from a crashed compaction\n')
    chmodSync(tmp, 0o644)
    crash.failUnlink = true

    const result = compactDispatchRegistry(file, NOW)
    expect(result.rewritten).toBe(true)
    // The fchmod happened, against the temp's descriptor, before the rename.
    const tempOpen = crash.opened.find((open) => open.path === tmp)
    expect(tempOpen).toBeDefined()
    expect(crash.fchmods).toContainEqual({ fd: tempOpen!.fd, mode: 0o600 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(lineCount(file)).toBe(1)
  })

  it('fsyncs the PARENT DIRECTORY after the rename — the entry is durable, not just atomic', () => {
    // The temp's own fsync makes the data durable; only a directory fsync
    // makes the NAME durable. Without it a power loss after "successful"
    // compaction can resurrect the pre-compaction registry.
    const file = compactable()
    const result = compactDispatchRegistry(file, NOW)
    expect(result.rewritten).toBe(true)

    const dir = path.dirname(file)
    const dirOpen = crash.opened.find((open) => open.path === dir)
    expect(dirOpen).toBeDefined()
    // Two fsyncs: the temp's data, then — LAST, after the rename — the
    // directory entry. (Descriptor NUMBERS can be reused once the temp
    // closes, so the order is pinned on the call sequence, not raw fds.)
    const tempOpen = crash.opened.find((open) => open.path === compactionTempPath(file))
    expect(tempOpen).toBeDefined()
    expect(crash.fsynced).toHaveLength(2)
    expect(crash.fsynced.at(-1)).toBe(dirOpen!.fd)
    expect(crash.opened.indexOf(tempOpen!)).toBeLessThan(crash.opened.indexOf(dirOpen!))
  })

  it('no directory fsync when nothing was rewritten', () => {
    const file = ledger()
    appendDispatchRecord(file, row({ id: 'dsp-a', state: 'done', updatedAt: NOW - DAY }))
    expect(compactDispatchRegistry(file, NOW).rewritten).toBe(false)
    expect(crash.opened.find((open) => open.path === path.dirname(file))).toBeUndefined()
  })
})
