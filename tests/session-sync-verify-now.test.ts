// The dispatch probation asks "did the observer materialize?" — and used to
// take a null as a final answer. 2026-11-03/04 the dispatch ledger recorded
// 16 asks "interrupted: observer never materialized" while the agents
// answered: eight GOAT Team cards were watched at a path built from a stale
// cwd, and six fresh recruits had a transcript on disk from second one. The
// probation's job is to catch a PERMANENTLY wrong session ref, so before it
// interrupts it now proves the observer once more: install the watch on the
// file the spec names today and reconcile on the spot.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTurnSync } from '../src/main/session-sync'
import { parseSessionTurns } from '../src/shared/session-turns'
import { TurnTracker } from '../src/main/turn-tracker'

const HEAD = [
  JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
  JSON.stringify({ type: 'attachment', timestamp: '2026-11-03T04:05:09.267Z' })
].join('\n') + '\n'

let syncs: SessionTurnSync[] = []
afterEach(() => {
  for (const s of syncs) s.dispose()
  syncs = []
})

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-verify-now-'))
  const file = path.join(dir, 'session.jsonl')
  const tracker = new TurnTracker(async () => null, null)
  // A poll slow enough that only verifyNow can explain a verified answer.
  const sync = new SessionTurnSync(tracker, 60_000)
  syncs.push(sync)
  return { dir, file, sync }
}

describe('SessionTurnSync.verifyNow', () => {
  it('materializes a terminal nothing was watching when its transcript exists', () => {
    const { file, sync } = setup()
    writeFileSync(file, HEAD)
    expect(sync.isVerified('t1')).toBe(false)
    expect(sync.verifyNow('t1', file, parseSessionTurns)).toBe(true)
    expect(sync.isVerified('t1')).toBe(true)
  })

  it('moves a watch stuck on a path that never appeared onto the real file, keeping the pin', () => {
    const { dir, file, sync } = setup()
    writeFileSync(file, HEAD)
    sync.watch('t1', path.join(dir, 'wrong-cwd', 'session.jsonl'), parseSessionTurns)
    sync.pin('t1')
    sync.release('t1')
    expect(sync.isVerified('t1')).toBe(false)
    expect(sync.verifyNow('t1', file, parseSessionTurns)).toBe(true)
    // Review finding: watch() reset `draining`, so a background terminal's
    // watch never drained after its dispatch unpinned — polled forever. The
    // move keeps it draining; the pin (a separate set) still holds it open.
    const entry = (sync as unknown as { watched: Map<string, { draining: boolean; file: string }> }).watched.get('t1')
    expect(entry?.file).toBe(file)
    expect(entry?.draining).toBe(true)
  })

  it('still answers false when no transcript exists — a wrong ref stays caught', () => {
    const { dir, sync } = setup()
    expect(sync.verifyNow('t1', path.join(dir, 'never.jsonl'), parseSessionTurns)).toBe(false)
  })

  it('says why a reconcile failed instead of swallowing it as "not written yet"', () => {
    const { file, sync } = setup()
    writeFileSync(file, HEAD)
    const broken = () => {
      throw new Error('parser exploded')
    }
    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
    try {
      expect(sync.verifyNow('t1', file, Object.assign(broken, {}) as never)).toBe(false)
      expect(sync.verifyNow('t1', file, Object.assign(broken, {}) as never)).toBe(false)
    } finally {
      spy.mockRestore()
    }
    // Logged once per terminal and message — a poll every two seconds must not flood.
    expect(errors.filter((args) => String(args.join(' ')).includes('parser exploded'))).toHaveLength(1)
  })
})
