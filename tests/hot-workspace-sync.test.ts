import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTurnSync, shouldSuspendSessionSync } from '../src/main/session-sync'
import { TurnTracker } from '../src/main/turn-tracker'
import type { TurnRecord } from '../src/shared/turn'

const syncs: SessionTurnSync[] = []

afterEach(() => {
  for (const sync of syncs.splice(0)) sync.dispose()
})

function record(index: number): TurnRecord {
  return {
    index,
    prompt: `prompt ${index}`,
    reply: `reply ${index}`,
    startedAt: index * 10,
    endedAt: index * 10 + 5
  }
}

function fixture(): {
  file: string
  tracker: TurnTracker
  sync: SessionTurnSync
  write: (records: TurnRecord[]) => void
} {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-hot-sync-')), 'turns.jsonl')
  const tracker = new TurnTracker(async () => null)
  const sync = new SessionTurnSync(tracker, 5)
  syncs.push(sync)
  const write = (records: TurnRecord[]): void => {
    writeFileSync(file, records.map((item) => JSON.stringify(item)).join('\n'), 'utf8')
  }
  return { file, tracker, sync, write }
}

const parse = (lines: string[]): TurnRecord[] =>
  lines.filter((line) => line.length > 0).map((line) => JSON.parse(line) as TurnRecord)

describe('service-aware session sync suspension', () => {
  it('keeps focused dormant sync live but suspends detached dormant and every parked lane', () => {
    expect(shouldSuspendSessionSync(true, 'dormant')).toBe(false)
    expect(shouldSuspendSessionSync(false, 'dormant')).toBe(true)
    expect(shouldSuspendSessionSync(true, 'parked')).toBe(true)
    expect(shouldSuspendSessionSync(false, 'parked')).toBe(true)
  })

  it('keeps polling a hot workspace after its PTY detaches', async () => {
    const { file, tracker, sync, write } = fixture()
    write([record(1)])
    sync.watch('agent-1', file, parse)
    expect(tracker.history('agent-1')).toHaveLength(1)

    sync.suspend('agent-1', 'hot')
    write([record(1), record(2)])

    await vi.waitFor(() => expect(tracker.history('agent-1')).toHaveLength(2))
  })

  it('stops polling dormant and parked workspaces', async () => {
    for (const serviceState of ['dormant', 'parked'] as const) {
      const { file, tracker, sync, write } = fixture()
      write([record(1)])
      sync.watch(serviceState, file, parse)
      sync.suspend(serviceState, serviceState)
      write([record(1), record(2)])
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(tracker.history(serviceState)).toHaveLength(1)
    }
  })
})
