import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  confine,
  confineExisting,
  confinedSpawn,
  safeSegment,
  sandboxRoot,
  seatbeltProfile,
  serviceRoot
} from '../src/main/session-sandbox'

/**
 * SEC-S SLICE 1 — the sandbox, exercised rather than described.
 *
 * The lexical tests are the cheap half. The half that matters spawns a real
 * process under a real profile and tries to escape, because a confinement
 * nobody has run is a confinement nobody has: the first profile I wrote blocked
 * the sandbox itself and still "looked right".
 */

let base = ''
beforeEach(() => { base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookrew-sbx-'))) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('path segments cannot climb, hide or collide', () => {
  it('refuses traversal outright rather than escaping it', () => {
    expect(safeSegment('../../etc')).not.toContain('..')
    expect(safeSegment('a/../../b')).not.toContain('/')
    expect(safeSegment('..')).toBe('unnamed')
  })

  it('collapses case, because macOS would collapse it anyway', () => {
    // Two accounts differing only in case must not silently share a sandbox on
    // a case-insensitive filesystem.
    expect(safeSegment('Ana')).toBe(safeSegment('ana'))
  })

  it('never yields an empty or dot-leading segment', () => {
    for (const raw of ['', '...', '///', '---', '.hidden']) {
      const out = safeSegment(raw)
      expect(out.length, raw).toBeGreaterThan(0)
      expect(out.startsWith('.'), raw).toBe(false)
    }
  })
})

describe('confine is the boundary, not a convention', () => {
  it('accepts the sandbox and things under it', () => {
    expect(confine('/s/ana-1', 'work/a.txt')).toBe('/s/ana-1/work/a.txt')
    expect(confine('/s/ana-1', '.')).toBe('/s/ana-1')
  })

  it('refuses the classic escapes', () => {
    for (const bad of ['..', '../ben-1', '/etc/passwd', 'work/../../ben-1', '../../../']) {
      expect(confine('/s/ana-1', bad), bad).toBeNull()
    }
  })

  it('refuses a SIBLING that shares a string prefix', () => {
    // /s/ana-1-evil starts with /s/ana-1. A prefix test without the separator
    // is the classic near-miss, and it hands one session another's directory.
    expect(confine('/s/ana-1', '/s/ana-1-evil')).toBeNull()
  })

  it('resolves symlinks before deciding, for paths that exist', () => {
    const sandbox = sandboxRoot(base, 'svc', 'ana-1')
    const outside = path.join(base, 'owner-secret')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, path.join(sandbox, 'escape'))
    // Lexically inside; actually a door out. confine cannot see it; the
    // resolving form must.
    expect(confine(sandbox, 'escape')).not.toBeNull()
    expect(confineExisting(sandbox, 'escape')).toBeNull()
  })
})

describe('the sandbox root is resolved, because a symlinked root voids a profile', () => {
  it('returns a realpath, not the path it was handed', () => {
    // The trap that would have shipped: on macOS /tmp resolves to /private/tmp,
    // and a Seatbelt subpath matches AFTER resolution — so a profile written
    // against the unresolved path denies everything including the sandbox, and
    // reads as a broken agent rather than a broken rule.
    const dir = sandboxRoot(base, 'svc', 'ana-1')
    expect(dir).toBe(realpathSync(dir))
    expect(existsSync(dir)).toBe(true)
  })

  it('keeps sessions of one service as siblings under its root', () => {
    const a = sandboxRoot(base, 'svc', 'ana-1')
    const b = sandboxRoot(base, 'svc', 'ben-1')
    expect(a).not.toBe(b)
    expect(a.startsWith(realpathSync(serviceRoot(base, 'svc')))).toBe(true)
    expect(b.startsWith(realpathSync(serviceRoot(base, 'svc')))).toBe(true)
  })
})

describe('the profile', () => {
  it('denies by default and allows exactly one write subpath', () => {
    const p = seatbeltProfile({ sandbox: '/s/ana-1', siblingRoot: '/s' })
    expect(p).toContain('(deny default)')
    expect(p.match(/allow file-write\* \(subpath/g)).toHaveLength(1)
    expect(p).toContain('(allow file-write* (subpath "/s/ana-1"))')
  })

  it('denies sibling reads AFTER allowing reads — last rule wins', () => {
    // Seatbelt takes the last matching rule, so a deny written above the allow
    // is silently overridden. This ordering IS the enforcement.
    const p = seatbeltProfile({ sandbox: '/s/ana-1', siblingRoot: '/s' })
    expect(p.indexOf('(deny file-read* (subpath "/s"))')).toBeGreaterThan(
      p.indexOf('(allow file-read*)')
    )
    // And its own subtree is re-allowed below the sibling deny.
    expect(p.lastIndexOf('(allow file-read* (subpath "/s/ana-1"))')).toBeGreaterThan(
      p.indexOf('(deny file-read* (subpath "/s"))')
    )
  })

  it('allows traversal of the service root as a LITERAL, not a subpath', () => {
    // Found by running it: a bare sibling deny made a session unable to reach
    // its own sandbox — `cd` failed with "Not a directory", because reaching a
    // child means traversing the parent. A subpath allow here would re-open
    // every sibling, so it must be the directory node alone.
    const p = seatbeltProfile({ sandbox: '/s/ana-1', siblingRoot: '/s' })
    expect(p).toContain('(allow file-read-metadata (literal "/s"))')
    expect(p).not.toContain('(allow file-read-metadata (subpath "/s"))')
  })

  it('quotes paths so one cannot end the s-expression', () => {
    const p = seatbeltProfile({ sandbox: '/s/a"b', siblingRoot: '/s' })
    expect(p).toContain('\\"')
  })

  it('wraps the command with sandbox-exec', () => {
    expect(confinedSpawn('/p.sb', 'tmux', ['new-session'])).toEqual({
      file: '/usr/bin/sandbox-exec',
      args: ['-f', '/p.sb', 'tmux', 'new-session']
    })
  })
})

/**
 * THE REAL THING. Skipped off macOS; on macOS it is the test that decides
 * whether any of the above is true.
 */
const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

describe.runIf(onMac)('a process under the profile cannot get out', () => {
  const run = (sandbox: string, siblingRoot: string, script: string): string => {
    const profile = path.join(sandbox, '..', `${path.basename(sandbox)}.sb`)
    writeFileSync(profile, seatbeltProfile({ sandbox, siblingRoot }))
    const spawn = confinedSpawn(profile, '/bin/sh', ['-c', script])
    try {
      return execFileSync(spawn.file, spawn.args, { encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      return `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  }

  it('writes INSIDE, and cannot write after cd ..', () => {
    const sandbox = sandboxRoot(base, 'svc', 'ana-1')
    const siblings = realpathSync(serviceRoot(base, 'svc'))
    const out = run(
      sandbox,
      siblings,
      `cd ${sandbox} && echo ok > a.txt && echo INSIDE-OK;
       cd ../.. && (echo x > escaped.txt 2>/dev/null && echo ESCAPED || echo CD-BLOCKED)`
    )
    expect(out).toContain('INSIDE-OK')
    expect(out).toContain('CD-BLOCKED')
    expect(out).not.toContain('ESCAPED')
    expect(existsSync(path.join(sandbox, 'a.txt'))).toBe(true)
  })

  it('cannot write into the owner\'s home', () => {
    const sandbox = sandboxRoot(base, 'svc', 'ana-1')
    const out = run(
      sandbox,
      realpathSync(serviceRoot(base, 'svc')),
      `(echo x > "$HOME/pwned.txt" 2>/dev/null && echo WROTE-HOME || echo HOME-BLOCKED)`
    )
    expect(out).toContain('HOME-BLOCKED')
  })

  it('cannot READ a sibling session — mutual invisibility', () => {
    const ana = sandboxRoot(base, 'svc', 'ana-1')
    const ben = sandboxRoot(base, 'svc', 'ben-1')
    writeFileSync(path.join(ben, 'private.txt'), 'ben-secret')
    const siblings = realpathSync(serviceRoot(base, 'svc'))
    const out = run(
      ana,
      siblings,
      `(cat ${ben}/private.txt 2>/dev/null && echo READ-SIBLING || echo SIBLING-BLOCKED);
       (cat ${ana}/../ben-1/private.txt 2>/dev/null && echo READ-VIA-DOTDOT || echo DOTDOT-BLOCKED)`
    )
    expect(out).not.toContain('ben-secret')
    expect(out).toContain('SIBLING-BLOCKED')
    expect(out).toContain('DOTDOT-BLOCKED')
  })

  it('CAN still read its own files — the deny must not be too wide', () => {
    // A sibling deny that also blinded a session to itself would be "secure"
    // and useless, and would surface as an inexplicably broken agent.
    const ana = sandboxRoot(base, 'svc', 'ana-1')
    writeFileSync(path.join(ana, 'mine.txt'), 'mine')
    const out = run(ana, realpathSync(serviceRoot(base, 'svc')), `cat ${ana}/mine.txt`)
    expect(out).toContain('mine')
  })
})
