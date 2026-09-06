import fs, { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CookrewEvent, EventLog } from '../src/main/event-log'

function event(overrides: Partial<CookrewEvent> = {}): CookrewEvent {
  return {
    type: 'terminal.created',
    entityId: 't1',
    entityName: 'Coder',
    workspaceId: 'ws-a',
    workspaceName: 'Alpha',
    actor: 'user',
    timestamp: 1000,
    ...overrides
  }
}

function makeLog(options = {}): { log: EventLog; file: string } {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-events-')), 'events.jsonl')
  return { log: new EventLog(file, { flushMs: 5, ...options }), file }
}

/**
 * The .jsonl files `run` read, by base name, in order. event-log.ts imports
 * named bindings from node:fs, so the counter goes on the default export and
 * the ESM bindings are re-synced — the technique tests/perf/latency.perf.ts
 * uses for the same question.
 */
function jsonlReadsDuring(run: () => void): string[] {
  const real = fs.readFileSync
  const seen: string[] = []
  fs.readFileSync = function counted(this: unknown, file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) {
    if (typeof file === 'string' && file.endsWith('.jsonl')) seen.push(path.basename(file))
    return (real as (...a: unknown[]) => Buffer | string).call(this, file, ...rest)
  } as typeof fs.readFileSync
  syncBuiltinESMExports()
  try {
    run()
  } finally {
    fs.readFileSync = real
    syncBuiltinESMExports()
  }
  return seen
}

const rotatedOf = (file: string, n: number): string => file.replace('.jsonl', `.${n}.jsonl`)

describe('EventLog', () => {
  afterEach(() => vi.useRealTimers())

  it('buffers appends, emits live, and flushes as JSONL', () => {
    const { log, file } = makeLog()
    const seen: CookrewEvent[] = []
    log.on('event', (e: CookrewEvent) => seen.push(e))

    log.append(event())
    log.append(event({ type: 'note.created', entityId: 'n1' }))
    expect(seen).toHaveLength(2) // live stream fires before the write
    expect(existsSync(file)).toBe(false) // not yet flushed (buffered)

    log.flush()
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).type).toBe('note.created')
  })

  it('keeps a burst off the caller hot path and coalesces it behind one timer', () => {
    vi.useFakeTimers()
    const { log, file } = makeLog({ flushMs: 200 })
    const seen: CookrewEvent[] = []
    log.on('event', (e: CookrewEvent) => seen.push(e))

    for (let i = 0; i < 30; i += 1) log.append(event({ entityId: `t${i}` }))

    expect(seen).toHaveLength(30)
    expect(existsSync(file)).toBe(false)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(199)
    expect(existsSync(file)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(30)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queries buffered + persisted events with filters', () => {
    const { log } = makeLog()
    log.append(event({ timestamp: 100 }))
    log.flush()
    log.append(event({ type: 'terminal.dismissed', workspaceId: 'ws-b', timestamp: 200 }))
    log.append(event({ type: 'workspace.switched', timestamp: 300 }))

    expect(log.query()).toHaveLength(3)
    expect(log.query({ workspaceId: 'ws-b' })).toHaveLength(1)
    expect(log.query({ type: 'terminal.' })).toHaveLength(2) // prefix filter
    expect(log.query({ type: 'workspace.switched' })).toHaveLength(1)
    expect(log.query({ since: 150, until: 250 })[0].type).toBe('terminal.dismissed')
    expect(log.query({ limit: 1 })[0].type).toBe('workspace.switched') // newest kept
  })

  it('counts by type for metrics', () => {
    const { log } = makeLog()
    log.append(event())
    log.append(event())
    log.append(event({ type: 'connection.made' }))
    expect(log.count()).toEqual({ 'terminal.created': 2, 'connection.made': 1 })
    expect(log.count({ type: 'terminal.' })).toEqual({ 'terminal.created': 2 })
  })

  it('rotates past the size cap keeping N files, and query spans them', () => {
    const { log, file } = makeLog({ maxBytes: 200, keepFiles: 2 })
    for (let i = 0; i < 8; i += 1) {
      log.append(event({ entityId: `t${i}`, timestamp: i }))
      log.flush() // each flush checks size, forcing rolls
    }
    expect(existsSync(file.replace('.jsonl', '.1.jsonl'))).toBe(true)
    // Rotation happened, nothing crashed, and recent events remain queryable.
    const all = log.query()
    expect(all.length).toBeGreaterThan(2)
    expect(all[all.length - 1].entityId).toBe('t7')
  })

  it('skips corrupt lines instead of failing the query', () => {
    const { log, file } = makeLog()
    log.append(event())
    log.flush()
    writeFileSync(file, readFileSync(file, 'utf8') + '{torn line\n', 'utf8')
    log.append(event({ type: 'note.created' }))
    expect(log.query()).toHaveLength(2)
  })

  describe('rotated files are parsed once', () => {
    const opts = { maxBytes: 600, keepFiles: 3 }

    /** Enough same-shaped events, flushed in fours, to fill every rotated slot. */
    function fillRotated(log: EventLog, count: number): void {
      for (let i = 0; i < count; i += 1) {
        log.append(
          event({ type: i % 3 === 0 ? 'turn.completed' : 'terminal.created', entityId: `t${i}`, timestamp: i })
        )
        if (i % 4 === 3) log.flush()
      }
    }

    it('a limited query on a rotated log keeps exactly the rows filter-then-slice kept', () => {
      const { log, file } = makeLog(opts)
      fillRotated(log, 60)
      log.append(event({ type: 'turn.completed', entityId: 't60', timestamp: 60 })) // stays buffered
      log.append(event({ entityId: 't61', timestamp: 61 }))
      expect(existsSync(rotatedOf(file, 3))).toBe(true)

      const liveFirst = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]) as CookrewEvent
      const queries = [
        { type: 'turn.completed' },
        { type: 'terminal.' },
        { types: ['turn.completed', 'terminal.created'] },
        { workspaceId: 'ws-a', since: 10, until: 50 },
        {}
      ]
      // The old code, verbatim: filter everything, then keep the tail.
      const oldTail = (rows: CookrewEvent[], limit: number): CookrewEvent[] =>
        rows.length > limit ? rows.slice(rows.length - limit) : rows
      for (const base of queries) {
        const reference = log.query(base)
        for (const limit of [1, 5, 13, 40, 1000, 0, -1, -0.5, 2.5, NaN, Infinity, -Infinity]) {
          expect(log.query({ ...base, limit }), JSON.stringify({ ...base, limit })).toEqual(oldTail(reference, limit))
        }
      }
      // The limited answer really spans the rotated files: keep two more rows
      // than events.jsonl and the buffer hold, and the oldest row predates
      // everything in events.jsonl while the newest is the buffered one.
      const timed = log.query({ type: 'turn.completed' })
      const recent = timed.filter((r) => r.timestamp >= liveFirst.timestamp).length
      const spanning = log.query({ type: 'turn.completed', limit: recent + 2 })
      expect(spanning).toHaveLength(recent + 2)
      expect(spanning[0].timestamp).toBeLessThan(liveFirst.timestamp)
      expect(spanning[recent + 1].entityId).toBe('t60')
    })

    it('reads only events.jsonl once the rotated files are cached, and follows a rotation', () => {
      const { log, file } = makeLog(opts)
      fillRotated(log, 40)
      expect(existsSync(rotatedOf(file, 3))).toBe(true)

      const cold = jsonlReadsDuring(() => log.query())
      expect(cold).toEqual(['events.3.jsonl', 'events.2.jsonl', 'events.1.jsonl', 'events.jsonl'])
      const warm = jsonlReadsDuring(() => log.query({ type: 'turn.completed', limit: 3 }))
      expect(warm).toEqual(['events.jsonl'])

      const before = log.query()
      const oldestBefore = before[0].entityId
      fillRotated(log, 60) // t40..t59 land, and the live file rolls at least once
      const after = log.query()
      // The rows are what a cache-less reader sees: the newest appended is
      // there, the oldest rotated file has been dropped, nothing stale.
      expect(after).toEqual(new EventLog(file, opts).query())
      expect(after[after.length - 1].entityId).toBe('t59')
      expect(after[0].entityId).not.toBe(oldestBefore)
      // Only the file that just left events.jsonl was parsed; the arrays that
      // moved from events.1 to events.2 and events.2 to events.3 came from
      // the cache.
      const reads = jsonlReadsDuring(() => log.query())
      expect(reads).toEqual(['events.jsonl'])
      // Query, then rotate exactly once, then query: one rotated read.
      const flushesUntilRoll = (): void => {
        const wasAt = fs.statSync(rotatedOf(file, 1)).ino
        let i = 100
        while (fs.statSync(rotatedOf(file, 1)).ino === wasAt) {
          if (i > 200) throw new Error('the live file never rotated')
          log.append(event({ entityId: `t${i}`, timestamp: i }))
          log.flush()
          i += 1
        }
      }
      flushesUntilRoll()
      expect(jsonlReadsDuring(() => log.query())).toEqual(['events.1.jsonl', 'events.jsonl'])
      expect(jsonlReadsDuring(() => log.query())).toEqual(['events.jsonl'])
    })

    it('re-reads a rotated file whose size changed underneath the cache', () => {
      const { log, file } = makeLog(opts)
      fillRotated(log, 40)
      log.query()
      const extra = event({ type: 'note.created', entityId: 'injected', timestamp: 7 })
      fs.appendFileSync(rotatedOf(file, 2), JSON.stringify(extra) + '\n', 'utf8')
      const rows = log.query({ type: 'note.created' })
      expect(rows.map((r) => r.entityId)).toEqual(['injected'])
      expect(jsonlReadsDuring(() => log.query())).toEqual(['events.jsonl'])
    })
  })
})
