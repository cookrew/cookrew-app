import { describe, expect, it } from 'vitest'
import { expandHome, parseEnvFile, readGrant } from '../src/main/service-grants'

/**
 * THE LEND'S SHAPE RULES. A grant file is hand-written, so every malformed
 * thing a person can type has to resolve to an answer — and the answers that
 * matter are the ones that REFUSE, because a grant that half-worked would hand
 * a stranger's agent the owner's credential with no bound on it.
 */

const HOME = '/Users/owner'
const cfg = (over: Record<string, unknown> = {}): unknown => ({
  'svc-research': { env: ['ANTHROPIC_API_KEY'], maxSessions: 3, ...over }
})

describe('readGrant — an unlisted service is lent nothing', () => {
  it('answers no grant for a service that is not in the file', () => {
    expect(readGrant(cfg(), 'svc-other', HOME)).toEqual({ grant: null, problems: [] })
  })

  it('answers no grant for a missing, null or non-object file', () => {
    for (const raw of [null, undefined, 42, 'nope', []]) {
      expect(readGrant(raw, 'svc-research', HOME).grant).toBeNull()
    }
  })

  it('says nothing at all about a service nobody lent to — silence is the default', () => {
    // No problems: not lending is the normal state, not a misconfiguration.
    expect(readGrant({}, 'svc-research', HOME).problems).toEqual([])
  })
})

describe('readGrant — the budget is required, and refuses the whole grant', () => {
  it('reads a well-formed grant', () => {
    const { grant, problems } = readGrant(cfg(), 'svc-research', HOME)
    expect(problems).toEqual([])
    expect(grant).toEqual({
      env: ['ANTHROPIC_API_KEY'],
      envFile: null,
      files: [],
      maxSessions: 3
    })
  })

  it('LENDS NOTHING when maxSessions is missing — never "unlimited"', () => {
    const { grant, problems } = readGrant(
      { 'svc-research': { env: ['ANTHROPIC_API_KEY'] } },
      'svc-research',
      HOME
    )
    expect(grant).toBeNull()
    expect(problems[0]).toMatch(/maxSessions/)
  })

  it('refuses a budget that is zero, negative, fractional or not a number', () => {
    for (const maxSessions of [0, -1, 1.5, '3', null, true]) {
      expect(readGrant(cfg({ maxSessions }), 'svc-research', HOME).grant).toBeNull()
    }
  })

  it('refuses a grant that is not an object at all, and says so', () => {
    const { grant, problems } = readGrant({ 'svc-research': 'yes please' }, 'svc-research', HOME)
    expect(grant).toBeNull()
    expect(problems[0]).toMatch(/not an object/)
  })
})

describe('readGrant — what may be lent', () => {
  it('refuses a name that would redefine the sandbox, and names it', () => {
    const { grant, problems } = readGrant(
      cfg({ env: ['ANTHROPIC_API_KEY', 'HOME', 'PATH'] }),
      'svc-research',
      HOME
    )
    // The safe name survives; the two that define the confinement do not.
    expect(grant?.env).toEqual(['ANTHROPIC_API_KEY'])
    expect(problems.join(' ')).toMatch(/HOME/)
    expect(problems.join(' ')).toMatch(/PATH/)
  })

  it.skipIf(process.platform === 'win32')('expands ~ in an envFile and keeps it absolute', () => {
    const { grant } = readGrant(cfg({ envFile: '~/.cookrew/qwen.env' }), 'svc-research', HOME)
    expect(grant?.envFile).toBe('/Users/owner/.cookrew/qwen.env')
  })

  it('refuses a relative envFile — a path that means different things per cwd', () => {
    const { grant, problems } = readGrant(cfg({ envFile: 'qwen.env' }), 'svc-research', HOME)
    expect(grant?.envFile).toBeNull()
    expect(problems.join(' ')).toMatch(/absolute/)
  })

  it.skipIf(process.platform === 'win32')('reads a file grant and resolves ~ on the source', () => {
    const { grant } = readGrant(
      cfg({ files: [{ from: '~/.pi/agent/models.json', to: '.pi/agent/models.json' }] }),
      'svc-research',
      HOME
    )
    expect(grant?.files).toEqual([
      { from: '/Users/owner/.pi/agent/models.json', to: '.pi/agent/models.json' }
    ])
  })

  it('refuses a destination that climbs out of the session folder', () => {
    // The lend must not become an overwrite of the owner's own files.
    const { grant, problems } = readGrant(
      cfg({ files: [{ from: '/etc/hosts', to: '../../../.claude/.credentials.json' }] }),
      'svc-research',
      HOME
    )
    expect(grant?.files).toEqual([])
    expect(problems.join(' ')).toMatch(/inside the session/)
  })

  it('refuses an absolute destination too — it is a path under the sandbox', () => {
    const { grant } = readGrant(
      cfg({ files: [{ from: '/etc/hosts', to: '/etc/hosts' }] }),
      'svc-research',
      HOME
    )
    // The leading slash is stripped, so this lands at <sandbox>/etc/hosts —
    // inside, which is the point: it can never name the real /etc.
    expect(grant?.files).toEqual([{ from: '/etc/hosts', to: 'etc/hosts' }])
  })

  it('drops a malformed files entry without losing the good ones', () => {
    const { grant, problems } = readGrant(
      cfg({
        files: [
          'not-a-pair',
          { from: '/a/b', to: 'b' },
          { from: 42, to: 'c' },
          { from: 'relative/x', to: 'd' }
        ]
      }),
      'svc-research',
      HOME
    )
    expect(grant?.files).toEqual([{ from: '/a/b', to: 'b' }])
    expect(problems).toHaveLength(3)
  })

  it('reports a list that is not a list rather than throwing', () => {
    const { grant, problems } = readGrant(
      cfg({ env: 'ANTHROPIC_API_KEY', files: {} }),
      'svc-research',
      HOME
    )
    expect(grant?.env).toEqual([])
    expect(problems).toHaveLength(2)
  })
})

describe('expandHome', () => {
  it.skipIf(process.platform === 'win32')('expands a leading ~ and nothing else', () => {
    expect(expandHome('~/x', HOME)).toBe('/Users/owner/x')
    expect(expandHome('~', HOME)).toBe(HOME)
    expect(expandHome('/abs/~/x', HOME)).toBe('/abs/~/x')
    expect(expandHome('rel/~x', HOME)).toBe('rel/~x')
  })
})

describe('parseEnvFile — small on purpose', () => {
  it('reads plain, exported and quoted values', () => {
    expect(
      parseEnvFile(
        [
          '# a comment',
          '',
          'PLAIN=one',
          'export EXPORTED=two',
          'QUOTED="three"',
          "SINGLE='four'",
          '  SPACED = five  '
        ].join('\n')
      )
    ).toEqual({
      PLAIN: 'one',
      EXPORTED: 'two',
      QUOTED: 'three',
      SINGLE: 'four',
      SPACED: 'five'
    })
  })

  it('keeps a value containing = intact', () => {
    expect(parseEnvFile('TOKEN=abc=def==')).toEqual({ TOKEN: 'abc=def==' })
  })

  it('skips lines it cannot read rather than guessing', () => {
    // Not a shell. A value that needs evaluation is absent, which fails
    // visibly, instead of being lent as the literal text of a command.
    expect(parseEnvFile('novalue\n=leading\n1BAD=x\nGOOD=y')).toEqual({ GOOD: 'y' })
  })
})
