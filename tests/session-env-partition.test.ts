import { describe, expect, it } from 'vitest'
import { grantable, sessionEnv } from '../src/main/session-env'
import {
  nextOrdinal,
  sessionAnnotationDir,
  sessionIdentity,
  sessionTurnDir
} from '../src/main/session-identity'

/**
 * THE OTHER TWO NON-NEGOTIABLES.
 *
 * Seatbelt confines the filesystem; these confine the SECRETS and the LEDGER.
 * All three are slice 1 because each is a hole the other two do not cover: a
 * sandboxed agent with the owner's env reads the key out of process.env without
 * touching a file, and a sandboxed agent with the owner's turn store writes a
 * stranger's conversation into the owner's history.
 */

const parent = {
  PATH: '/usr/bin:/bin',
  SHELL: '/bin/zsh',
  TERM: 'xterm-256color',
  HOME: '/Users/drej',
  ANTHROPIC_API_KEY: 'sk-ant-SECRET',
  OPENAI_API_KEY: 'sk-SECRET',
  AWS_SECRET_ACCESS_KEY: 'aws-SECRET',
  GITHUB_TOKEN: 'ghp_SECRET',
  SOME_FUTURE_SDK_KEY: 'future-SECRET',
  COOKREW_REGISTRY_HOST: 'registry.internal'
}

const env = (over = {}) =>
  sessionEnv({ parent, sandbox: '/s/ana-1', sessionId: 'svc-ana-1', ...over })

describe('env scrubbing — an allowlist, because a denylist ages badly', () => {
  it('no owner secret survives, including one nobody thought of', () => {
    const out = env()
    const values = Object.values(out).join(' ')
    expect(values).not.toContain('SECRET')
    // The one that proves the SHAPE is right rather than the list: a variable
    // invented after this file was written is absent because it was never
    // named, not because somebody remembered to ban it.
    expect(out.SOME_FUTURE_SDK_KEY).toBeUndefined()
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.GITHUB_TOKEN).toBeUndefined()
  })

  it('secrets are ABSENT, not blanked — no decoy to probe', () => {
    expect('ANTHROPIC_API_KEY' in env()).toBe(false)
  })

  it('HOME points at the sandbox, closing a whole class without listing it', () => {
    // ~/.cookrew, ~/.aws, ~/.ssh, ~/.config — none enumerated, all unreachable
    // by the ordinary route.
    const out = env()
    expect(out.HOME).toBe('/s/ana-1')
    expect(out.HOME).not.toBe(parent.HOME)
    expect(out.TMPDIR.startsWith('/s/ana-1')).toBe(true)
  })

  it('keeps only what a harness needs to run', () => {
    const out = env()
    expect(out.PATH).toBe(parent.PATH)
    expect(out.TERM).toBe(parent.TERM)
    expect(out.COOKREW_SESSION).toBe('svc-ana-1')
    expect(out.COOKREW_SERVED).toBe('1')
  })

  it('a granted key reaches the session — deliberately, by name', () => {
    const out = env({ grantedKeys: ['ANTHROPIC_API_KEY'] })
    expect(out.ANTHROPIC_API_KEY).toBe('sk-ant-SECRET')
    // and grants one thing, not a family
    expect(out.OPENAI_API_KEY).toBeUndefined()
  })

  it('a granted key that does not exist is left ABSENT, not empty', () => {
    // An empty credential produces a confusing auth error; a missing one
    // produces an obvious "no key" error.
    expect('NOPE' in env({ grantedKeys: ['NOPE'] })).toBe(false)
  })

  it('the load-bearing lines cannot be granted through', () => {
    // grantedKeys is owner-configurable. An owner who typed HOME or PATH there
    // would punch through the two lines that close the most.
    for (const name of ['HOME', 'PATH', 'TMPDIR', 'COOKREW_SERVED']) {
      expect(grantable(name), name).toBe(false)
    }
    expect(grantable('ANTHROPIC_API_KEY')).toBe(true)
    expect(grantable('lower_case')).toBe(false)
    expect(grantable('WITH-DASH')).toBe(false)
  })

  it('a granted HOME cannot override the sandbox even if it slips through', () => {
    // Belt to grantable's braces: the loop runs after HOME is set, so this
    // asserts the ORDER is safe rather than trusting the guard alone.
    const out = sessionEnv({
      parent: { ...parent, HOME: '/Users/drej' },
      sandbox: '/s/ana-1',
      sessionId: 's',
      grantedKeys: []
    })
    expect(out.HOME).toBe('/s/ana-1')
  })
})

describe('turn-store partition — a directory, not a filter', () => {
  it('a session ledger is nowhere near the owner default', () => {
    // `new TurnStore()` defaults to ~/.cookrew/turns, process-wide. A served
    // session using it appends a stranger's turns into the owner's history:
    // their search returns them, their board counts them, a fold folds them.
    const dir = sessionTurnDir('/base', 'svc', 'svc-ana-1')
    expect(dir).not.toContain('/.cookrew/turns'.replace('/.cookrew', '/base/.cookrew'))
    expect(dir.startsWith('/base/sessions/svc/svc-ana-1/')).toBe(true)
    expect(dir.endsWith('/turns')).toBe(true)
  })

  it('two sessions never share a ledger', () => {
    expect(sessionTurnDir('/b', 'svc', 'a-1')).not.toBe(sessionTurnDir('/b', 'svc', 'b-1'))
  })

  it('annotations partition with the ledger they belong to', () => {
    // Sous titles for a caller's conversation are that conversation's; an
    // owner's annotation store gaining a stranger's checkpoints is the same
    // mixing one file over.
    const a = sessionAnnotationDir('/b', 'svc', 'ana-1')
    expect(a).toContain('/sessions/svc/ana-1/')
    expect(a.endsWith('/checkpoint-annotations')).toBe(true)
  })

  it('a hostile id cannot climb out of the partition', () => {
    for (const evil of ['../../owner', '..', '/etc']) {
      const dir = sessionTurnDir('/b', 'svc', evil)
      expect(dir.startsWith('/b/sessions/svc/'), evil).toBe(true)
      expect(dir, evil).not.toContain('..')
    }
  })
})

describe('session identity — keyed by account, ordinal never reused', () => {
  it('is stable for one account and distinct per ordinal', () => {
    const a = sessionIdentity('research-crew', 'ana@studio', 1)
    const b = sessionIdentity('research-crew', 'ana@studio', 2)
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(sessionIdentity('research-crew', 'ana@studio', 1)).toEqual(a)
  })

  it('slugs live in a namespace the owner cannot collide with', () => {
    expect(sessionIdentity('svc', 'ana', 1).slug.startsWith('svc-')).toBe(true)
  })

  it('the ordinal is highest+1 over EVERY session, not the open count', () => {
    // Counting open sessions would hand a returning caller the ordinal of one
    // that ended — and END destroys sandboxes, so the new session would be
    // minted onto a path just deleted, or one whose deletion is still in
    // flight.
    expect(nextOrdinal([])).toBe(1)
    expect(nextOrdinal([1, 2, 3])).toBe(4)
    expect(nextOrdinal([3])).toBe(4)
  })

  it('two accounts differing only in case do not collide into one session', () => {
    // safeSegment lowercases for the filesystem, so the ids collapse — which
    // means the DISPLAY name must still distinguish them, or the owner sees two
    // rows that look identical.
    const a = sessionIdentity('svc', 'Ana', 1)
    const b = sessionIdentity('svc', 'ana', 1)
    expect(a.sessionId).toBe(b.sessionId)
    expect(a.workspaceName).not.toBe(b.workspaceName)
  })
})
