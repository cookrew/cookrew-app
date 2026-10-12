import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareChoresDir, trustDirectory } from '../src/main/claude-trust'

function scratch(): { home: string; claudeJson: string; chores: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'claude-trust-'))
  return { home, claudeJson: path.join(home, '.claude.json'), chores: path.join(home, '.cookrew', 'chores') }
}

describe('trustDirectory', () => {
  it('creates ~/.claude.json with the entry when the file is absent', () => {
    const { claudeJson, chores } = scratch()
    expect(trustDirectory(chores, claudeJson)).toBe('trusted')
    const config = JSON.parse(readFileSync(claudeJson, 'utf8'))
    expect(config.projects[chores].hasTrustDialogAccepted).toBe(true)
  })

  it('keeps every other key and every other project untouched', () => {
    const { claudeJson, chores } = scratch()
    writeFileSync(claudeJson, JSON.stringify({ numStartups: 7, projects: { '/x/app': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } }))
    expect(trustDirectory(chores, claudeJson)).toBe('trusted')
    const config = JSON.parse(readFileSync(claudeJson, 'utf8'))
    expect(config.numStartups).toBe(7)
    expect(config.projects['/x/app']).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true })
    expect(config.projects[chores].hasTrustDialogAccepted).toBe(true)
  })

  it('is idempotent: a second call writes nothing', () => {
    const { claudeJson, chores } = scratch()
    trustDirectory(chores, claudeJson)
    const before = readFileSync(claudeJson, 'utf8')
    expect(trustDirectory(chores, claudeJson)).toBe('already-trusted')
    expect(readFileSync(claudeJson, 'utf8')).toBe(before)
  })

  it('never rewrites a malformed config', () => {
    const { claudeJson, chores } = scratch()
    writeFileSync(claudeJson, '{ not json')
    expect(trustDirectory(chores, claudeJson)).toBe('skipped-unreadable')
    expect(readFileSync(claudeJson, 'utf8')).toBe('{ not json')
  })

  it('keeps the file mode the owner set', () => {
    const { claudeJson, chores } = scratch()
    writeFileSync(claudeJson, '{}', { mode: 0o640 })
    trustDirectory(chores, claudeJson)
    expect(statSync(claudeJson).mode & 0o777).toBe(0o640)
  })
})

describe('prepareChoresDir', () => {
  it('creates the directory 0700 and trusts it, even when the directory already exists', () => {
    const { claudeJson, chores } = scratch()
    mkdirSync(chores, { recursive: true, mode: 0o755 })
    expect(prepareChoresDir(chores, claudeJson)).toBe('trusted')
    expect(statSync(chores).isDirectory()).toBe(true)
    expect(JSON.parse(readFileSync(claudeJson, 'utf8')).projects[chores].hasTrustDialogAccepted).toBe(true)
  })
})
