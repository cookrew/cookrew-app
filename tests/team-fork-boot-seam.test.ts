import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * THE SEAM — boot separated from focus.
 *
 * forkTeam ended by calling switchWorkspace for its SIDE EFFECT: the switch is
 * what boots the forked terminals. Correct for an owner forking on their own
 * canvas; wrong for anything created on their behalf, because a served session
 * would yank the owner's screen to a stranger's workspace on that stranger's
 * first call — once per caller, forever.
 *
 * Asserted against the source because the alternative is a PTY. What matters is
 * structural and checkable: the default is still the switch, so every existing
 * caller is byte-unchanged.
 */
const teams = readFileSync(path.join(__dirname, '..', 'src', 'main', 'teams.ts'), 'utf8')
const code = teams.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('forkTeam asks for BOOT; the caller decides about focus', () => {
  it('boots through the seam, not through the switch', () => {
    expect(code).toContain('(deps.bootTerminals ?? deps.switchWorkspace)(meta.id)')
  })

  it('DEFAULTS to switching, so cookrew workspace create --team is unchanged', () => {
    // The nullish default is the whole compatibility story: an existing caller
    // that passes no bootTerminals gets exactly the previous behaviour.
    expect(code).toContain('deps.bootTerminals ?? deps.switchWorkspace')
    expect(code).toContain('bootTerminals?:')
  })

  it('no longer calls switchWorkspace unconditionally at the end of a fork', () => {
    // The regression this guards: someone re-adding the bare call would restore
    // the hijack for served sessions, and nothing else would fail.
    expect(code).not.toMatch(/\n\s*deps\.switchWorkspace\(meta\.id\)/)
  })
})
