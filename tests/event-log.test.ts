import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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

describe('EventLog', () => {
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
})
