import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import {
  continuedInOf,
  followContinuedIn,
  resolveClaudeSessionId,
  resolveExistingClaudeSession
} from '../src/main/claude-fork'

/**
 * A recover resumes the file claude is WRITING, not the one the node was
 * bound to hours ago. Claude states the switch itself — `continued-in` at the
 * tail of the old file — and both resolvers follow it, so the strict recover
 * gate and the spawn path cannot disagree about which conversation is live.
 */
const OLD = '413c8c39-60cf-4d5a-8fb2-961f1445bfee'
const NEW = '176cfe9f-a225-40c9-b6c1-fa7c6d27af16'
const THIRD = '9703d0f7-1057-43aa-80d9-c467077ed119'
const CWD = '/work/repo'

const marker = (from: string, to: string): string =>
  JSON.stringify({ type: 'continued-in', sessionId: from, continuedInSessionId: to })
const record = (sid: string, text: string): string =>
  JSON.stringify({ type: 'user', uuid: `u-${text}`, sessionId: sid, message: { role: 'user', content: text }, timestamp: '2026-09-02T10:00:00.000Z' })

function project(files: Record<string, string[]>): string {
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-continued-'))
  const dir = path.join(projectsDir, claudeProjectSlug(CWD))
  mkdirSync(dir, { recursive: true })
  for (const [sid, lines] of Object.entries(files)) writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n')
  return projectsDir
}

describe('continued-in', () => {
  it('reads the marker off a tail, and only the marker', () => {
    expect(continuedInOf([record(OLD, 'a'), marker(OLD, NEW)])).toBe(NEW)
    expect(continuedInOf([marker(OLD, NEW), record(OLD, 'after')])).toBe(NEW)
    expect(continuedInOf([record(OLD, 'a')])).toBeNull()
    expect(continuedInOf(['{"type":"continued-in","continuedInSessionId":"../etc"}'])).toBeNull()
    expect(continuedInOf(['not json "continued-in"'])).toBeNull()
  })

  it('both resolvers follow the marker to the file claude is writing now', () => {
    const projectsDir = project({
      [OLD]: [record(OLD, 'morning'), marker(OLD, NEW)],
      [NEW]: [record(NEW, 'evening')]
    })
    const options = { command: 'claude', cwd: CWD, storedId: OLD, turns: [], projectsDir }
    expect(followContinuedIn(CWD, OLD, projectsDir)).toBe(NEW)
    expect(resolveClaudeSessionId(options)).toBe(NEW)
    expect(resolveExistingClaudeSession(options)).toBe(NEW)
  })

  it('walks a chain, ignores a successor that is not on disk, and never loops', () => {
    const chained = project({
      [OLD]: [marker(OLD, NEW)],
      [NEW]: [marker(NEW, THIRD)],
      [THIRD]: [record(THIRD, 'now'), marker(THIRD, 'dddddddd-1111-4222-8333-444444444444')]
    })
    expect(followContinuedIn(CWD, OLD, chained)).toBe(THIRD)
    const loop = project({ [OLD]: [marker(OLD, NEW)], [NEW]: [marker(NEW, OLD)] })
    expect(followContinuedIn(CWD, OLD, loop)).toBe(NEW)
  })

  it('finds a marker buried under a stray branch far past the last few KB', () => {
    // The accident itself: the old file was resumed after its marker and
    // grew 520 KB of a branch nothing should keep. The marker still says
    // where the conversation went.
    const filler = Array.from({ length: 3000 }, (_, i) => record(OLD, `stray ${i} ${'x'.repeat(200)}`))
    const projectsDir = project({
      [OLD]: [record(OLD, 'morning'), marker(OLD, NEW), ...filler],
      [NEW]: [record(NEW, 'evening')]
    })
    expect(followContinuedIn(CWD, OLD, projectsDir)).toBe(NEW)
  })

  it('a file with no marker resolves to itself', () => {
    const projectsDir = project({ [OLD]: [record(OLD, 'only')] })
    expect(resolveClaudeSessionId({ command: 'claude', cwd: CWD, storedId: OLD, turns: [], projectsDir })).toBe(OLD)
  })
})
