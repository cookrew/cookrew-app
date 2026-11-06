import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { blockStands, cleanTail, commandWord, exitFailure, launchBlock } from '../src/main/launch-check'

describe('commandWord', () => {
  it('the program a command line starts', () => {
    expect(commandWord('claude --permission-mode bypassPermissions')).toBe('claude')
    expect(commandWord('  codex  ')).toBe('codex')
    expect(commandWord('/opt/tools/pi --x')).toBe('/opt/tools/pi')
  })

  it('skips env assignments in front of it', () => {
    expect(commandWord('FOO=1 BAR=two claude --x')).toBe('claude')
  })

  it('a bare Shell has no command to look for', () => {
    expect(commandWord('')).toBeNull()
    expect(commandWord('   ')).toBeNull()
  })

  it('shell syntax is the shell\'s to read: nothing is guessed', () => {
    expect(commandWord('cd sub && claude')).toBeNull()
    expect(commandWord("'/path with space/x' --y")).toBeNull()
    expect(commandWord('$HOME/bin/x')).toBeNull()
    expect(commandWord('(claude)')).toBeNull()
  })
})

describe('launchBlock', () => {
  let root: string
  let bin: string
  let file: string

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cookrew-launch-'))
    bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'tool'), '#!/bin/sh\n')
    chmodSync(path.join(bin, 'tool'), 0o755)
    writeFileSync(path.join(bin, 'notexec'), 'x')
    chmodSync(path.join(bin, 'notexec'), 0o644)
    file = path.join(root, 'notafolder.txt')
    writeFileSync(file, 'x')
  })

  const check = (over: { cwd?: string; command?: string; path?: string; checkCommand?: boolean }) =>
    launchBlock({ cwd: root, command: 'tool', path: bin, checkCommand: true, installLine: () => null, ...over })

  it('all there: nothing blocks it', () => {
    expect(check({})).toBeNull()
    expect(check({ command: '' })).toBeNull()
  })

  it('a missing folder names the folder, and is blocked', () => {
    const failure = check({ cwd: '/does/not/exist' })
    expect(failure).toMatchObject({ kind: 'folder-missing', blocked: true, exitCode: null })
    expect(failure?.why).toContain('/does/not/exist')
    expect(failure?.fix.length).toBeGreaterThan(0)
  })

  it('a file where the folder should be says so', () => {
    const failure = check({ cwd: file })
    expect(failure).toMatchObject({ kind: 'folder-not-directory', blocked: true })
    expect(failure?.why).toContain(file)
  })

  it('a bare Shell in a missing folder is blocked too', () => {
    expect(check({ cwd: '/does/not/exist', command: '' })?.kind).toBe('folder-missing')
  })

  it('a missing command is named, with the exit code a shell would give', () => {
    const failure = check({ command: 'claude --permission-mode bypassPermissions' })
    expect(failure).toMatchObject({ kind: 'command-missing', blocked: true, exitCode: 127 })
    expect(failure?.why).toContain('claude')
    expect(failure?.fix).toContain('PATH')
  })

  it('the fix is the install line when the harness has one', () => {
    const failure = launchBlock({
      cwd: root,
      command: 'claude',
      path: bin,
      checkCommand: true,
      installLine: (word) => (word === 'claude' ? 'tool install claude' : null)
    })
    expect(failure?.fix).toContain('tool install claude')
  })

  it('a file that is not executable is not a command', () => {
    expect(check({ command: 'notexec' })?.kind).toBe('command-missing')
  })

  it('a path is looked at as a path, against the card\'s folder', () => {
    expect(check({ command: path.join(bin, 'tool') })).toBeNull()
    expect(check({ command: '/nope/tool' })?.kind).toBe('command-missing')
    expect(check({ cwd: bin, command: './tool' })).toBeNull()
  })

  it('the folder is asked first: a missing folder is the fix to make', () => {
    expect(check({ cwd: '/does/not/exist', command: 'nothing-here' })?.kind).toBe('folder-missing')
  })

  it('a backend whose PATH this cannot see leaves the command alone', () => {
    expect(check({ command: 'nothing-here', checkCommand: false })).toBeNull()
  })

  it('a folder it may not look at is not called missing: only what is certain blocks', () => {
    const locked = path.join(root, 'locked')
    mkdirSync(path.join(locked, 'inner'), { recursive: true })
    chmodSync(locked, 0o000)
    try {
      expect(check({ cwd: path.join(locked, 'inner') })).toBeNull()
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('a command behind a PATH folder it may not read is not called missing', () => {
    const locked = path.join(root, 'lockedbin')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect(check({ command: 'nothing-here', path: `${bin}:${locked}` })).toBeNull()
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('a relative PATH entry is read from the card\'s folder, as the pane will', () => {
    expect(check({ cwd: root, command: 'tool', path: 'bin' })).toBeNull()
  })

  it('shell syntax is never called missing', () => {
    expect(check({ command: 'cd sub && nothing-here' })).toBeNull()
  })
})

describe('exitFailure', () => {
  const base = { name: 'claude', agent: true, exitCode: null, signal: null, tail: [] as string[], ranMs: 900, reattached: false }

  it('an agent gone right after it started failed, whatever the code', () => {
    const failure = exitFailure({ ...base, exitCode: 0, tail: ['Update required'] })
    expect(failure).toMatchObject({ kind: 'exited', blocked: false, exitCode: 0, lastLines: ['Update required'] })
    expect(failure?.why).toContain('claude')
  })

  it('names the code when there is one, and does not invent one', () => {
    expect(exitFailure({ ...base, exitCode: 3 })?.why).toContain('exit 3')
    expect(exitFailure(base)?.why).not.toMatch(/exit \d/)
  })

  it('names a signal', () => {
    expect(exitFailure({ ...base, signal: 'kill' })?.why).toContain('signal kill')
  })

  it('a long run that ended clean is no failure', () => {
    expect(exitFailure({ ...base, exitCode: 0, ranMs: 3_600_000 })).toBeNull()
    expect(exitFailure({ ...base, ranMs: 3_600_000 })).toBeNull()
  })

  it('an agent that dies with an error after a long run still says why', () => {
    expect(exitFailure({ ...base, exitCode: 1, ranMs: 3_600_000 })?.why).toContain('exit 1')
  })

  it('a Shell someone typed exit in is no failure', () => {
    expect(exitFailure({ ...base, agent: false, exitCode: 0 })).toBeNull()
    expect(exitFailure({ ...base, agent: false, exitCode: 1, ranMs: 3_600_000 })).toBeNull()
    expect(exitFailure({ ...base, agent: false, exitCode: null })).toBeNull()
  })

  it('a Shell that failed on start is one', () => {
    expect(exitFailure({ ...base, name: 'Shell', agent: false, exitCode: 1 })?.kind).toBe('exited')
  })

  it('a reattached pane that ended says nothing of a launch', () => {
    expect(exitFailure({ ...base, exitCode: null, reattached: true })).toBeNull()
    expect(exitFailure({ ...base, exitCode: 0, reattached: true })).toBeNull()
    expect(exitFailure({ ...base, exitCode: 1, reattached: true })?.kind).toBe('exited')
  })
})

describe('cleanTail', () => {
  it('the last words on screen, without escapes or the multiplexer\'s own', () => {
    const raw = '\x1b[31mError: boom\x1b[0m\r\n  at x\r\n\r\n[exited]\r\n'
    expect(cleanTail(raw)).toEqual(['Error: boom', '  at x'])
  })

  it('drops tmux\'s dead-pane line', () => {
    expect(cleanTail('oops\nPane is dead (status 127, Thu Nov  5 12:08:55 2026)\n')).toEqual(['oops'])
  })

  it('keeps only the last lines, each bounded', () => {
    const lines = cleanTail(`${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n${'x'.repeat(500)}`)
    expect(lines).toHaveLength(6)
    expect(lines.at(-2)).toBe('line 19')
    expect(lines.at(-1)?.length).toBeLessThanOrEqual(200)
  })
})

describe('blockStands', () => {
  const known = { kind: 'folder-missing', why: 'gone', fix: 'x', blocked: true, exitCode: null, lastLines: [], at: 1 } as const

  it('a husk keeps its failure: a pane listed proves nothing about the folder', () => {
    expect(blockStands(known, known)).toBe(true)
  })

  it('lifts once the cause itself has gone', () => {
    expect(blockStands(known, null)).toBe(false)
  })

  it('a card that died on its own has nothing a check could lift', () => {
    expect(blockStands({ ...known, kind: 'exited', blocked: false }, null)).toBe(false)
    expect(blockStands(null, known)).toBe(false)
  })
})

describe('where a cut agent lands', () => {
  it('its own folder when the target lists it, else the target\'s primary', async () => {
    const { resolveTargetDir } = await import('../src/main/teams')
    expect(resolveTargetDir('/a', undefined, ['/b', '/a'])).toBe('/a')
    expect(resolveTargetDir('/a', undefined, ['/b', '/c'])).toBe('/b')
  })
})
