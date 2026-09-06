// THE SPAWN HALF OF THE CHECKPOINT ⇔ LIVE-TRANSCRIPT INVARIANT — permanent.
//
// 2026-09-06, the third and last defect behind the checkpoint-rail churn.
// `findExistingClaudeSession` picked a card's session by SCORING RECENT
// TRANSCRIPT FILES (prompt match, then mtime) and never asked the live
// processes what they were writing. A BACKGROUND JOB launched from a terminal
// inherits that terminal's environment and writes its own transcript — recent,
// and matching the same prompts — so the card adopted the JOB's session at
// spawn, the 30 s oracle sweep rebound it to the pane agent's real session,
// and the two took turns. Measured on Conductor: 20 lineage slots holding four
// distinct ids, 295d5f1c ↔ a78aa3e5 eight times, with rotate events in one
// direction only — which is how you can tell the wrong adoption happens at
// spawn and not in the sweep.
//
// The rail jumping between two conversations is the visible half; the history
// filling with churn is the other. Four claims are pinned here:
//
//   F1  a live pane holder outranks every file: its session IS the answer,
//       and neither the stored binding nor the best-scoring file is consulted
//   F2  a session a `kind === 'bg'` holder writes is never adopted — not even
//       when it is the newest file and the best prompt match
//   F3  a binding that would move BACK to an id it left inside the damping
//       window is refused (a card that ping-pongs is a bug report)
//   F4  a genuine rotation — an id the card has never left — still lands at
//       once, in the same tick
//
// Shapes reused from tests/checkpoint-live-transcript-gate.test.ts (G1-G3) and
// tests/checkpoint-gate-verdict.test.ts (V1-V3).

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TurnRecord } from '../src/shared/turn'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import { resolveClaudeSessionId, resolveExistingClaudeSession } from '../src/main/claude-fork'
import { mayAdopt, sessionAuthority } from '../src/main/claude-session-adoption'
import type { SessionHolder } from '../src/main/claude-live-session'
import {
  REBIND_BACKOFF_MS,
  RebindDamper,
  allowsRebind
} from '../src/main/rebind-damper'
import { flapVerdict } from '../src/shared/checkpoint-gate.mjs'

/** The two sessions that took turns on Conductor's card, and its pane. */
const PANE = '295d5f1c-1c62-4b3f-9b0e-2c9d0f1a4b77'
const BG = 'a78aa3e5-6f01-4a0e-9c33-0d8a1b2c3d4e'
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d'
const CWD = '/work/repo'
const T0 = Date.parse('2026-09-06T04:00:00.000Z')

function turn(index: number): TurnRecord {
  return {
    index,
    prompt: `prompt ${index}`,
    reply: `reply ${index}`,
    startedAt: T0 + index * 60_000,
    endedAt: T0 + index * 60_000 + 30_000
  }
}

function sessionLines(turnCount: number, sessionId: string): string[] {
  const body = Array.from({ length: turnCount }, (_, i) => [
    JSON.stringify({
      type: 'user',
      uuid: `u${i}`,
      sessionId,
      timestamp: new Date(T0 + i * 60_000).toISOString(),
      message: { role: 'user', content: `prompt ${i + 1}` }
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: `a${i}`,
      sessionId,
      timestamp: new Date(T0 + i * 60_000 + 20_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i + 1}` }] }
    })
  ]).flat()
  return [JSON.stringify({ type: 'mode', sessionId }), ...body]
}

function projectDir(): { projectsDir: string; dir: string } {
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-flap-'))
  const dir = path.join(projectsDir, claudeProjectSlug(CWD))
  mkdirSync(dir, { recursive: true })
  return { projectsDir, dir }
}

function writeSession(dir: string, id: string, turnCount: number, mtime: number): void {
  const file = path.join(dir, `${id}.jsonl`)
  writeFileSync(file, `${sessionLines(turnCount, id).join('\n')}\n`)
  utimesSync(file, mtime, mtime)
}

const holder = (pid: number, sessionId: string, kind: string): SessionHolder => ({
  pid,
  sessionId,
  kind,
  cwd: CWD
})

describe('F1 — a live pane holder outranks every file', () => {
  /**
   * The pane's process writes PANE; the newest file with the best prompt
   * match is BG, and the card is even STORED on BG. Before the fix the stored
   * id short-circuited to BG and the scan would have confirmed it.
   */
  function fixture(): { projectsDir: string } {
    const { projectsDir, dir } = projectDir()
    writeSession(dir, PANE, 1, 1_000)
    writeSession(dir, BG, 4, 9_000)
    return { projectsDir }
  }

  it('adopts the session the pane process reports, not the file', () => {
    const { projectsDir } = fixture()
    expect(
      resolveClaudeSessionId({
        command: 'claude',
        cwd: CWD,
        storedId: BG,
        turns: [turn(1), turn(2), turn(3), turn(4)],
        projectsDir,
        live: { panePid: 5002, holders: [holder(5002, PANE, 'interactive')] }
      })
    ).toBe(PANE)
  })

  it('and the scan really would have answered otherwise (the churn)', () => {
    // Same fixture with no live statement: the newest, best-scoring file wins
    // — this is the answer the card kept adopting and the sweep kept undoing.
    const { projectsDir } = fixture()
    expect(
      resolveClaudeSessionId({
        command: 'claude',
        cwd: CWD,
        storedId: null,
        turns: [turn(1), turn(2), turn(3), turn(4)],
        projectsDir,
        live: { holders: [] }
      })
    ).toBe(BG)
  })

  it('refuses the pane pid when the holder is a background job', () => {
    const authority = sessionAuthority({ panePid: 5001, holders: [holder(5001, BG, 'bg')] }, CWD)
    expect(authority.paneSession).toBeNull()
  })
})

describe('F2 — a background holder’s session is never adopted', () => {
  it('refuses it at spawn even as the newest, best-scoring file', () => {
    const { projectsDir, dir } = projectDir()
    writeSession(dir, OTHER, 4, 1_000) // this card's real, older session
    writeSession(dir, BG, 4, 9_000) // the job's transcript: newer, same prompts
    const options = {
      command: 'claude',
      cwd: CWD,
      storedId: null,
      turns: [turn(1), turn(2), turn(3), turn(4)],
      projectsDir
    }
    expect(
      resolveClaudeSessionId({
        ...options,
        live: { holders: [holder(5001, BG, 'bg')] }
      })
    ).toBe(OTHER)
    // Without the bg holder the job's file is exactly what wins — the defect.
    expect(resolveClaudeSessionId({ ...options, live: { holders: [] } })).toBe(BG)
  })

  it('refuses it on the strict recover path too — one filter, every caller', () => {
    const { projectsDir, dir } = projectDir()
    writeSession(dir, BG, 4, 9_000)
    expect(
      resolveExistingClaudeSession({
        command: 'claude',
        cwd: CWD,
        storedId: null,
        turns: [turn(1), turn(2), turn(3), turn(4)],
        projectsDir,
        live: { holders: [holder(5001, BG, 'bg')] }
      })
    ).toBeNull()
  })

  it('refuses a bg session baked into the launch command', () => {
    const { projectsDir, dir } = projectDir()
    writeSession(dir, BG, 1, 9_000)
    expect(
      resolveExistingClaudeSession({
        command: `claude --resume ${BG}`,
        cwd: CWD,
        storedId: null,
        turns: [],
        projectsDir,
        live: { holders: [holder(5001, BG, 'bg')] }
      })
    ).toBeNull()
  })

  it('names the refused sessions structurally, not per call site', () => {
    const authority = sessionAuthority(
      { holders: [holder(5001, BG, 'bg'), holder(5002, PANE, 'interactive')] },
      CWD
    )
    expect(authority.refused.has(BG)).toBe(true)
    expect(mayAdopt(BG, authority)).toBe(false)
    expect(mayAdopt(PANE, authority)).toBe(true)
  })
})

describe('F3 — a binding never returns to an id it just left', () => {
  it('refuses the way back inside the window and allows it after', () => {
    let clock = T0
    const damper = new RebindDamper(() => clock)
    damper.left('card', PANE) // the card rebound PANE -> BG
    expect(damper.allows('card', PANE)).toBe(false)
    clock += REBIND_BACKOFF_MS - 1
    expect(damper.allows('card', PANE)).toBe(false)
    clock += 2
    expect(damper.allows('card', PANE)).toBe(true)
  })

  it('is per card — one card’s churn never damps another', () => {
    const damper = new RebindDamper(() => T0)
    damper.left('conductor', PANE)
    expect(damper.allows('conductor', PANE)).toBe(false)
    expect(damper.allows('forge', PANE)).toBe(true)
  })

  it('the decision is pure and window-bounded', () => {
    const departures = [{ sessionId: PANE, at: T0 }]
    expect(allowsRebind(PANE, departures, T0 + 1_000, REBIND_BACKOFF_MS)).toBe(false)
    expect(allowsRebind(PANE, departures, T0 + REBIND_BACKOFF_MS, REBIND_BACKOFF_MS)).toBe(true)
    expect(allowsRebind(BG, departures, T0 + 1_000, REBIND_BACKOFF_MS)).toBe(true)
  })

  it('the ping-pong fixture: A → B, then B → A is refused, B → A → B is not stacked', () => {
    let clock = T0
    const damper = new RebindDamper(() => clock)
    damper.left('conductor', PANE) // A -> B
    clock += 30_000 // one oracle sweep later
    expect(damper.allows('conductor', PANE)).toBe(false) // B -> A refused
    clock += 40_000 // the window has passed
    expect(damper.allows('conductor', PANE)).toBe(true)
  })
})

describe('F4 — a genuine rotation still rebinds at once', () => {
  it('a session the card has never left lands in the same tick', () => {
    const damper = new RebindDamper(() => T0)
    damper.left('conductor', PANE)
    // /compact, /clear or a resume mints a session id nothing has left.
    expect(damper.allows('conductor', OTHER)).toBe(true)
  })

  it('a card with no history at all is never damped', () => {
    const damper = new RebindDamper(() => T0)
    expect(damper.allows('fresh', PANE)).toBe(true)
  })

  it('and the record is dropped with the card', () => {
    const damper = new RebindDamper(() => T0)
    damper.left('conductor', PANE)
    damper.forget('conductor')
    expect(damper.allows('conductor', PANE)).toBe(true)
  })
})

describe('F5 — the gate reports a card that alternates (FLAP, never a failure)', () => {
  it('a chain of rotations onto fresh ids is not a flap', () => {
    expect(flapVerdict({ rotations: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] })).toMatchObject({
      verdict: 'OK',
      ids: []
    })
  })

  it('a destination the card has already rotated onto is a flap', () => {
    // Conductor, 2026-09-06: 295d5f1c ↔ a78aa3e5, eight times.
    const rotations = ['295d5f1c', 'a78aa3e5', '295d5f1c', 'a78aa3e5']
    const verdict = flapVerdict({ rotations })
    expect(verdict.verdict).toBe('FLAP')
    expect(verdict.ids).toEqual(['295d5f1c', 'a78aa3e5'])
  })

  it('only the recent window counts — an old repeat is history, not a flap', () => {
    const rotations = ['295d5f1c', 'a78aa3e5', '295d5f1c', ...Array.from({ length: 8 }, (_, i) => `0000000${i}`)]
    expect(flapVerdict({ rotations }).verdict).toBe('OK')
  })

  it('an empty log says nothing', () => {
    expect(flapVerdict({ rotations: [] }).verdict).toBe('OK')
  })
})
