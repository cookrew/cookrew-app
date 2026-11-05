// Where a Claude session's transcript REALLY lives, whatever the card says.
//
// 2026-11-04: eight GOAT Team cards said cwd goat-dev while their claude ran
// in goat-testnet/solis-orch. Claude files a transcript under the project dir
// of its LAUNCH directory, so `claudeWatchFile` built a path that never
// appeared, the session observer never materialized, and the dispatch sweep
// interrupted every --no-wait ask to them 60 s in — 16 of 137 since 10-31,
// while the agents answered.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeCwdRepair,
  claudeLaunchDir,
  claudeWatchFile,
  dirForSlug,
  findClaudeSessionHome,
  forgetClaudeSessionHomes,
  locateClaudeSessionFile
} from '../src/main/claude-fork'
import { claudeProjectSlug } from '../src/shared/claude-fork'

const ID = '106961c8-6d17-4414-9ce9-2713c93578ee'

function world() {
  forgetClaudeSessionHomes()
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookrew-session-home-')))
  const projects = path.join(root, 'projects')
  const cardDir = path.join(root, 'goat-dev')
  const realDir = path.join(root, 'solis-orch')
  mkdirSync(cardDir, { recursive: true })
  mkdirSync(realDir, { recursive: true })
  const realProject = path.join(projects, claudeProjectSlug(realDir))
  mkdirSync(realProject, { recursive: true })
  mkdirSync(path.join(projects, claudeProjectSlug(cardDir)), { recursive: true })
  const file = path.join(realProject, `${ID}.jsonl`)
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'summary' }),
      JSON.stringify({ type: 'user', cwd: realDir, message: { role: 'user', content: 'hi' } })
    ].join('\n') + '\n'
  )
  return { projects, cardDir, realDir, file }
}

describe('findClaudeSessionHome', () => {
  it('finds the transcript by id in another project dir', () => {
    const { projects, file } = world()
    expect(findClaudeSessionHome(ID, { projectsDir: projects })).toEqual({ file })
    expect(locateClaudeSessionFile('/nowhere', ID, projects)).toBe(file)
  })

  it('answers null for an id no project holds', () => {
    const { projects } = world()
    expect(findClaudeSessionHome('00000000-0000-4000-8000-000000000000', { projectsDir: projects })).toBeNull()
  })

  it('refuses a malformed id before touching the filesystem', () => {
    const { projects } = world()
    expect(findClaudeSessionHome('../../etc/passwd', { projectsDir: projects })).toBeNull()
  })
})

describe('claudeWatchFile', () => {
  it('watches the real transcript when the card cwd disagrees with the launch dir', () => {
    const { projects, cardDir, file } = world()
    expect(claudeWatchFile({ cwd: cardDir, claudeSessionId: ID }, { projectsDir: projects })).toBe(file)
  })

  it('keeps the card-cwd path for a session not written yet (the sync polls until it appears)', () => {
    const { projects, cardDir } = world()
    const fresh = '11111111-1111-4111-8111-111111111111'
    expect(claudeWatchFile({ cwd: cardDir, claudeSessionId: fresh }, { projectsDir: projects })).toBe(
      path.join(projects, claudeProjectSlug(cardDir), `${fresh}.jsonl`)
    )
  })
})

describe('claudeCwdRepair', () => {
  it('names the launch directory when the session lives elsewhere — a respawn must resume THERE', () => {
    const { projects, cardDir, realDir } = world()
    expect(claudeCwdRepair({ cwd: cardDir, sessionId: ID, projectsDir: projects })).toBe(realDir)
  })

  it('is null when the card cwd already holds the session', () => {
    const { projects, realDir } = world()
    expect(claudeCwdRepair({ cwd: realDir, sessionId: ID, projectsDir: projects })).toBeNull()
  })

  it('is null when no transcript exists anywhere', () => {
    const { projects, cardDir } = world()
    expect(claudeCwdRepair({ cwd: cardDir, sessionId: '22222222-2222-4222-8222-222222222222', projectsDir: projects })).toBeNull()
  })
})

describe('claudeLaunchDir', () => {
  it('reads the launch dir from a head record whose slug is the project dir', () => {
    const { file, realDir } = world()
    expect(claudeLaunchDir(file)).toBe(realDir)
  })

  it('rebuilds it from the project dir name when no record in the head carries a cwd', () => {
    // Review finding: 46 of 291 local transcripts carry no cwd in 8 MiB, and
    // 29 carry the first one past 64 KiB — the head alone left a drifted
    // card unrepaired and its respawn booting a blank conversation.
    const { file, realDir } = world()
    writeFileSync(file, JSON.stringify({ type: 'summary' }) + '\n')
    expect(claudeLaunchDir(file)).toBe(realDir)
  })

  it('walks a dashed directory name as one segment', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookrew-slug-')))
    const dashed = path.join(root, 'goat-testnet', 'solis-orch')
    mkdirSync(dashed, { recursive: true })
    expect(dirForSlug(claudeProjectSlug(dashed))).toBe(dashed)
  })

  it('answers null — never a guess — when no directory matches', () => {
    expect(dirForSlug('-definitely-not-a-real-dir-4f1c')).toBeNull()
  })
})
