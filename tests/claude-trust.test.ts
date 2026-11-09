import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { directoryTrust, isBroadFolder, prepareChoresDir, trustDirectory } from '../src/main/claude-trust'

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

describe('directoryTrust', () => {
  it('reads an exact entry, an ancestor entry, no entry, and an unreadable file', () => {
    const { claudeJson } = scratch()
    expect(directoryTrust('/w/app', claudeJson)).toBe('untrusted')
    writeFileSync(claudeJson, JSON.stringify({ projects: { '/w': { hasTrustDialogAccepted: true }, '/x': { hasTrustDialogAccepted: false } } }))
    expect(directoryTrust('/w', claudeJson)).toBe('trusted')
    // Claude walks up from its folder, so a trusted parent answers for the child.
    expect(directoryTrust('/w/app/src', claudeJson)).toBe('trusted')
    expect(directoryTrust('/x/app', claudeJson)).toBe('untrusted')
    expect(directoryTrust('/wx', claudeJson)).toBe('untrusted')
    writeFileSync(claudeJson, '[1]')
    expect(directoryTrust('/w', claudeJson)).toBe('unreadable')
  })
})

describe('isBroadFolder', () => {
  it('is the home folder, the root, or anything above home, and nothing below', () => {
    expect(isBroadFolder('/home/ubuntu', '/home/ubuntu')).toBe(true)
    expect(isBroadFolder('/', '/home/ubuntu')).toBe(true)
    expect(isBroadFolder('/home', '/home/ubuntu')).toBe(true)
    expect(isBroadFolder('/home/ubuntu/app', '/home/ubuntu')).toBe(false)
    expect(isBroadFolder('/home/ubuntu2', '/home/ubuntu')).toBe(false)
    expect(isBroadFolder('/srv/app', '/home/ubuntu')).toBe(false)
  })
})
