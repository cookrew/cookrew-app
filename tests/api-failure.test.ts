import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_ROUTES,
  classifyHttpFailure,
  diagnoseStreamFailure,
  failureScope,
  isBootstrapRoute,
  isReadOnlyRefusal,
  isScopeError,
  noticeForError,
  ScopeError
} from '../src/renderer/src/api-failure'
import { AuthError } from '../src/renderer/src/auth-gate'

/**
 * The server's exact messages (src/main/auth-gate.ts gateMessage). The
 * "read-only" phrase is a contract between the two files, so the fixtures are
 * verbatim rather than paraphrased.
 */
const UNAUTHORIZED = 'Unauthorized — open the pairing URL shown on the desktop (it carries ?token=).'
const READ_ONLY = 'Forbidden — this token is read-only.'
const UNKNOWN_ROUTE = 'Forbidden — unknown route.'
const OUT_OF_SCOPE = "Forbidden — this route is outside your token's scope."

describe('classifyHttpFailure', () => {
  it('treats 401 as a dead credential wherever it happens', () => {
    expect(classifyHttpFailure({ status: 401, message: UNAUTHORIZED, path: '/api/board' })).toBe(
      'credential'
    )
    expect(
      classifyHttpFailure({ status: 401, message: UNAUTHORIZED, path: '/api/nodes', method: 'POST' })
    ).toBe('credential')
  })

  it('does NOT evict the app for an out-of-scope read — the D6 regression', () => {
    // The wall renders its board with an authorized token, then reads one
    // route outside `observe`. That must not replace the whole app with a
    // re-pair screen the wall has no keyboard to satisfy.
    expect(classifyHttpFailure({ status: 403, message: READ_ONLY, path: '/api/events/query' })).toBe(
      'scope'
    )
    expect(
      classifyHttpFailure({ status: 403, message: READ_ONLY, path: '/api/terminal/t1/turns' })
    ).toBe('scope')
  })

  it('keeps the re-pair screen for a read-only device attempting a WRITE', () => {
    // This is the C1 behaviour worth preserving: keystrokes that vanish in
    // silence were the original bug, and here re-pairing really is the fix.
    for (const method of ['POST', 'DELETE', 'PUT', 'post']) {
      expect(
        classifyHttpFailure({ status: 403, message: READ_ONLY, path: '/api/terminal/t1/raw', method })
      ).toBe('credential')
    }
  })

  it('calls a scoped write a scope failure when re-pairing would not help', () => {
    // Not read-only — a full credential refused for THIS workspace/route.
    // A stronger token does not exist, so evicting the app teaches nothing.
    expect(
      classifyHttpFailure({
        status: 403,
        message: OUT_OF_SCOPE,
        path: '/api/workspaces/other/dirs',
        method: 'POST'
      })
    ).toBe('scope')
    expect(
      classifyHttpFailure({ status: 403, message: UNKNOWN_ROUTE, path: '/api/nope', method: 'POST' })
    ).toBe('scope')
  })

  it('evicts on a 403 against a bootstrap route — nothing can render', () => {
    for (const path of BOOTSTRAP_ROUTES) {
      expect(classifyHttpFailure({ status: 403, message: OUT_OF_SCOPE, path })).toBe('credential')
    }
  })

  it('matches bootstrap routes exactly, never by prefix', () => {
    // /api/workspaces/:id/... is an ordinary scoped route; a prefix match here
    // would evict the whole app over one workspace's data.
    expect(isBootstrapRoute('/api/workspaces')).toBe(true)
    expect(isBootstrapRoute('/api/workspaces/ws-1/dirs')).toBe(false)
    expect(isBootstrapRoute('/api/workspaces/switch')).toBe(false)
    expect(isBootstrapRoute('/api/workspace-thing')).toBe(false)
    expect(
      classifyHttpFailure({ status: 403, message: OUT_OF_SCOPE, path: '/api/workspaces/ws-1' })
    ).toBe('scope')
  })

  it('ignores the query string when matching a bootstrap route', () => {
    expect(isBootstrapRoute('/api/workspace?token=abc')).toBe(true)
  })

  it('defaults an unspecified method to GET, the safe reading', () => {
    // An unknown method must not be assumed to be a write: guessing wrong in
    // that direction evicts the app.
    expect(classifyHttpFailure({ status: 403, message: READ_ONLY, path: '/api/board' })).toBe('scope')
  })

  it('leaves every other status to ordinary error handling', () => {
    for (const status of [400, 404, 409, 429, 500, 503]) {
      expect(classifyHttpFailure({ status, message: 'boom', path: '/api/board' })).toBe('other')
    }
  })

  it('reads the read-only marker the server keeps on purpose', () => {
    expect(isReadOnlyRefusal(READ_ONLY)).toBe(true)
    expect(isReadOnlyRefusal(OUT_OF_SCOPE)).toBe(false)
    expect(isReadOnlyRefusal(UNKNOWN_ROUTE)).toBe(false)
    expect(failureScope(READ_ONLY)).toBe('read-only')
    expect(failureScope(UNAUTHORIZED)).toBe('none')
  })
})

describe('ScopeError', () => {
  it('carries where it happened and whether a stronger credential exists', () => {
    const error = new ScopeError(READ_ONLY, '/api/events/query', true)
    expect(isScopeError(error)).toBe(true)
    expect(error.path).toBe('/api/events/query')
    expect(error.readOnly).toBe(true)
    expect(error.name).toBe('ScopeError')
    expect(error).toBeInstanceOf(Error)
  })

  it('is not an AuthError — the type is what keeps it off the re-pair screen', () => {
    expect(new ScopeError(READ_ONLY, '/api/board', true)).not.toBeInstanceOf(AuthError)
    expect(isScopeError(new AuthError('nope', 'none'))).toBe(false)
    expect(isScopeError(new Error(READ_ONLY))).toBe(false)
  })
})

describe('noticeForError', () => {
  it('names a read-only refusal as one', () => {
    const notice = noticeForError(new ScopeError(READ_ONLY, '/api/events/query', true), 'The log')
    expect(notice.kind).toBe('scope')
    expect(notice.message).toContain('read-only')
    expect(notice.message).toContain('The log')
  })

  it('names a scope refusal without inventing a read-only credential', () => {
    const notice = noticeForError(new ScopeError(OUT_OF_SCOPE, '/api/board', false), 'The board')
    expect(notice.kind).toBe('scope')
    expect(notice.message).not.toContain('read-only')
  })

  it('says a plain failure failed rather than showing an empty state', () => {
    const notice = noticeForError(new Error('network down'), 'The log')
    expect(notice.kind).toBe('unavailable')
    expect(notice.message).toContain('could not be loaded')
  })
})

describe('diagnoseStreamFailure', () => {
  it('ignores a drop after the stream delivered something', () => {
    // EventSource reconnects on its own; a tower handoff is not an auth event.
    expect(diagnoseStreamFailure({ opened: true, scope: 'none' })).toEqual({ action: 'ignore' })
    expect(diagnoseStreamFailure({ opened: true, scope: null })).toEqual({ action: 'ignore' })
  })

  it('reports an unpaired device — that one IS app-level', () => {
    const verdict = diagnoseStreamFailure({ opened: false, scope: 'none' })
    expect(verdict).toMatchObject({ action: 'report', scope: 'none' })
  })

  it('gives a read-only device a card notice, not an eviction', () => {
    const verdict = diagnoseStreamFailure({ opened: false, scope: 'read-only' })
    expect(verdict.action).toBe('notice')
    if (verdict.action !== 'notice') throw new Error('unreachable')
    expect(verdict.notice.kind).toBe('scope')
    expect(verdict.notice.message).toContain('read-only')
  })

  it('explains an otherwise-refused stream instead of leaving the card blank', () => {
    for (const scope of ['pairing', null] as const) {
      const verdict = diagnoseStreamFailure({ opened: false, scope })
      expect(verdict.action).toBe('notice')
      if (verdict.action !== 'notice') throw new Error('unreachable')
      expect(verdict.notice.kind).toBe('unavailable')
      expect(verdict.notice.message.length).toBeGreaterThan(0)
    }
  })

  it('never reports for a credential the server still accepts', () => {
    // The whole failure mode: one refused stream evicting an authorized app.
    for (const scope of ['pairing', 'read-only', null] as const) {
      expect(diagnoseStreamFailure({ opened: false, scope }).action).not.toBe('report')
    }
  })
})
