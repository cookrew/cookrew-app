import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog, type CookrewEvent } from '../../src/main/event-log'
import { defaultStorageRoots, sweepStorage } from '../../src/main/storage-gc-scan'
import { TeamStore } from '../../src/main/teams'
import { claudeProjectSlug } from '../../src/shared/claude-fork'
import type { TerminalNodeData, WorkspaceState } from '../../src/shared/model'
import { LATENCY } from './budgets'
import { expectEvery, expectTail, measure, removeRoot, tempRoot, timed } from './perf-harness'

/**
 * Storage-growth gates: the stores that write to ~/.cookrew must be BOUNDED,
 * and the sweep that reclaims them must be cheap.
 *
 * The live machine is the reason these exist. On 2026-09-05 ~/.cookrew was
 * 1.3 GB, of which 1.0 GB was team session sidecars, 93 MB one served
 * session, and ~70 MB hand-made backup directories — none of which the
 * sweep in storage-gc-scan.ts looks at. The gates below pin what IS bounded
 * today, and record what is not as an expected failure so the day it is
 * fixed the suite says so.
 */

const DAY = 24 * 60 * 60 * 1000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

function root(prefix: string): string {
  const made = tempRoot(prefix)
  roots.push(made)
  return made
}

const dirBytes = (dir: string): number =>
  existsSync(dir) ? readdirSync(dir).reduce((sum, f) => sum + statSync(path.join(dir, f)).size, 0) : 0

function event(i: number): CookrewEvent {
  return {
    type: 'terminal.created',
    entityId: `terminal-${i}`,
    entityName: `Agent ${i}`,
    workspaceId: 'perf-workspace',
    workspaceName: 'Perf Eval',
    actor: 'user',
    timestamp: 1_800_000_000_000 + i
  }
}

describe('event log — disk is bounded by the rotation policy', () => {
  it('never holds more than keepFiles+1 files or their combined cap plus one batch', () => {
    const dir = root('rotation')
    const maxBytes = 64 * 1024
    const keepFiles = 3
    const log = new EventLog(path.join(dir, 'events.jsonl'), { maxBytes, keepFiles, flushMs: 60_000 })
    // Twenty caps' worth, flushed one event at a time so a single line is the
    // largest overshoot rotation can ever permit.
    const lineBytes = JSON.stringify(event(0)).length + 1
    const total = Math.ceil((maxBytes * 20) / lineBytes)
    for (let i = 0; i < total; i += 1) {
      log.append(event(i))
      log.flush()
    }
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBe(keepFiles + 1)
    expect(dirBytes(dir)).toBeLessThanOrEqual((keepFiles + 1) * maxBytes + lineBytes)
    // And the newest event is still there — rotation drops the OLDEST.
    expect(log.query({ limit: 1 })[0].entityId).toBe(`terminal-${total - 1}`)
  })
})

// ---------------------------------------------------------------------------
// Team session sidecars.
// ---------------------------------------------------------------------------

function terminal(id: string, sessionId: string | null): TerminalNodeData {
  return {
    kind: 'terminal',
    id,
    name: `Agent ${id}`,
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 10, y: 20 },
    size: { width: 400, height: 300 },
    claudeSessionId: sessionId
  }
}

function state(nodes: TerminalNodeData[]): WorkspaceState {
  return { name: 'Crew', dir: '/work/repo', dirs: ['/work/repo'], nodes, connections: [] }
}

/** A fake ~/.claude/projects with one session file per id, `kb` KB each. */
function sessions(base: string, ids: string[], kb: number): string {
  const projects = path.join(base, 'projects')
  const dir = path.join(projects, claudeProjectSlug('/work/repo'))
  mkdirSync(dir, { recursive: true })
  for (const id of ids) writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ id })}\n`.padEnd(kb * 1024, 'x'))
  return projects
}

describe('team store — session sidecars follow the saved team', () => {
  it('copies one file per bound terminal, and a re-save prunes what the team no longer holds', () => {
    const base = root('sidecar')
    const projects = sessions(base, ['s1', 's2', 's3'], 64)
    const teams = new TeamStore(path.join(base, 'teams'), projects)
    const three = [terminal('a', 's1'), terminal('b', 's2'), terminal('c', 's3')]
    teams.save(state(three), () => [], 'Crew')
    const sidecar = path.join(base, 'teams', 'crew-sessions')
    expect(readdirSync(sidecar).sort()).toEqual(['a.jsonl', 'b.jsonl', 'c.jsonl'])
    expect(dirBytes(sidecar)).toBe(3 * 64 * 1024)

    teams.save(state([three[0]]), () => [], 'Crew')
    expect(readdirSync(sidecar)).toEqual(['a.jsonl'])
    expect(dirBytes(sidecar)).toBe(64 * 1024)

    // No bound sessions at all: the sidecar directory itself goes.
    teams.save(state([terminal('a', null)]), () => [], 'Crew')
    expect(existsSync(sidecar)).toBe(false)
  })

  // KNOWN GAP, pinned as it stands. The sweep collects dead turn ledgers and
  // orphaned attachments; it does not look at teams/*-sessions. A team whose
  // JSON is gone leaves its sidecar behind forever — on the live machine
  // cookrew-core-sessions carries four files its team no longer names.
  //
  // Written as a positive assertion of today's behaviour rather than
  // `it.fails`, because `it.fails` is satisfied by ANY throw — a renamed
  // export in the setup would have kept the gate green while the gap stayed
  // open. The day the sweep reclaims sidecars this fails loudly: flip the
  // final expectation to `false` and retitle it.
  it('does NOT yet reclaim a sidecar whose team file is gone (known gap)', () => {
    const base = root('orphan')
    const projects = sessions(base, ['s1'], 16)
    const teams = new TeamStore(path.join(base, 'teams'), projects)
    teams.save(state([terminal('a', 's1')]), () => [], 'Crew')
    const teamFile = path.join(base, 'teams', 'crew.json')
    const sidecar = path.join(base, 'teams', 'crew-sessions')
    rmSync(teamFile)
    const old = new Date(Date.now() - 90 * DAY)
    utimesSync(path.join(sidecar, 'a.jsonl'), old, old)

    const storeRoots = defaultStorageRoots(base)
    for (const dir of Object.values(storeRoots)) mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(storeRoots.workspaces, 'workspace.json'), JSON.stringify({ nodes: [] }))
    const swept = sweepStorage({ roots: storeRoots, apply: true })
    expect(swept.applied).toBe(true)
    expect(swept.remove).toEqual([])
    expect(existsSync(path.join(sidecar, 'a.jsonl'))).toBe(true)
  })
})

describe('storage sweep — planning is cheap at live scale', () => {
  it('plans 300 ledgers and 200 attachments within budget and finds every dead one', async () => {
    const base = root('sweep')
    const storeRoots = defaultStorageRoots(base)
    for (const dir of Object.values(storeRoots)) mkdirSync(dir, { recursive: true })
    const live = Array.from({ length: 100 }, (_, i) => `live-${i}`)
    mkdirSync(path.join(storeRoots.workspaces, 'w1'), { recursive: true })
    writeFileSync(
      path.join(storeRoots.workspaces, 'w1', 'workspace.json'),
      JSON.stringify({ nodes: live.map((id) => ({ id, kind: 'terminal' })) })
    )
    const old = new Date(Date.now() - 90 * DAY)
    const aged = (file: string): void => {
      writeFileSync(file, '{}\n'.repeat(200))
      utimesSync(file, old, old)
    }
    for (const id of live) aged(path.join(storeRoots.turns, `${id}.jsonl`))
    for (let i = 0; i < 200; i += 1) aged(path.join(storeRoots.turns, `dead-${i}.jsonl`))
    for (let i = 0; i < 200; i += 1) aged(path.join(storeRoots.attachments, `orphan-${i}.png`))

    const measured = await measure('storage sweep plan 300+200', () =>
      timed(() => {
        const plan = sweepStorage({ roots: storeRoots, apply: false })
        return { remove: plan.remove.length, live: plan.kept.live, applied: plan.applied }
      })
    )
    expectTail(measured, LATENCY.storageSweepPlan)
    expectEvery(measured, 'remove', 400)
    expectEvery(measured, 'live', 100)
    expectEvery(measured, 'applied', false)
  })
})
