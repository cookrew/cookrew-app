import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultStorageRoots, sweepStorage } from '../../src/main/storage-gc-scan'
import { LATENCY } from './budgets'
import { expectEvery, expectTail, measure, removeRoot, tempRoot, timed } from './perf-harness'

/**
 * Served-session retention and the backup-residue report, at the live
 * machine's shape (2026-09-06: 43 sandboxes, 83 MB, ~455 files each; six
 * hand-made backup dirs, 34 MB). The structural assertions are the gate — an
 * open session survives whatever its age, an unknown open set plans nothing,
 * residue is named and never removed — and the tail budget is the alarm.
 */

const DAY = 24 * 60 * 60 * 1000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

function aged(file: string, body: string, ageDays: number): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  const when = new Date(Date.now() - ageDays * DAY)
  utimesSync(file, when, when)
}

function ageDirs(dir: string, ageDays: number): void {
  const when = new Date(Date.now() - ageDays * DAY)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) ageDirs(path.join(dir, entry.name), ageDays)
  }
  utimesSync(dir, when, when)
}

/** A sandbox shaped like a real one: a plugin clone of many small files. */
function sandbox(sessions: string, key: string, files: number, ageDays: number): void {
  for (let i = 0; i < files; i += 1) {
    aged(path.join(sessions, key, '.claude', 'plugins', `p${i % 20}`, `f${i}.md`), 'x'.repeat(64), ageDays)
  }
  aged(path.join(sessions, key, '.cookrew', 'turns', 'orch.jsonl'), '{}', ageDays)
  ageDirs(path.join(sessions, key), ageDays)
}

describe('storage sweep — served sessions and residue at live scale', () => {
  it('plans 40 sandboxes x 450 files within budget, keeps the open and the recent, reports residue', async () => {
    const base = tempRoot('served')
    roots.push(base)
    const storeRoots = defaultStorageRoots(base)
    for (const dir of Object.values(storeRoots)) mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(storeRoots.workspaces, 'workspace.json'), JSON.stringify({ nodes: [] }))
    // 30 ended and aged, 5 open (and aged — age must not matter), 5 ended but recent.
    for (let i = 0; i < 30; i += 1) sandbox(storeRoots.sessions, `svc-door/ended-${i}`, 450, 90)
    for (let i = 0; i < 5; i += 1) sandbox(storeRoots.sessions, `svc-door/open-${i}`, 450, 90)
    for (let i = 0; i < 5; i += 1) sandbox(storeRoots.sessions, `svc-door/recent-${i}`, 450, 1)
    const open = Array.from({ length: 5 }, (_, i) => `svc-door/open-${i}`)
    for (let i = 0; i < 6; i += 1) aged(path.join(base, `turns.bak-2026080${i}`, 'a.jsonl'), 'x'.repeat(1024), 30)

    const measured = await measure('storage sweep plan served 40', () =>
      timed(() => {
        const plan = sweepStorage({ roots: storeRoots, apply: false, openServedSessions: open })
        const blind = sweepStorage({ roots: storeRoots, apply: false })
        return {
          remove: plan.remove.length,
          removedEnded: plan.remove.every((c) => c.key.startsWith('svc-door/ended-')),
          live: plan.kept.live,
          withinGrace: plan.kept.withinGrace,
          residue: plan.residue.length,
          residueBytes: plan.residueBytes,
          residueNeverRemoved: plan.remove.every((c) => !c.path.includes('.bak-')),
          blindRemoves: blind.remove.length
        }
      })
    )
    expectTail(measured, LATENCY.storageSweepServed40)
    expectEvery(measured, 'remove', 30)
    expectEvery(measured, 'removedEnded', true)
    expectEvery(measured, 'live', 5)
    expectEvery(measured, 'withinGrace', 5)
    expectEvery(measured, 'residue', 6)
    expectEvery(measured, 'residueBytes', 6 * 1024)
    expectEvery(measured, 'residueNeverRemoved', true)
    expectEvery(measured, 'blindRemoves', 0)
    expect(existsSync(path.join(storeRoots.sessions, 'svc-door', 'ended-0'))).toBe(true)
  })
})
