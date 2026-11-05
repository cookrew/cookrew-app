// A ladder nobody is climbing holds nothing. `cookrew login` opens one and its
// terminal can vanish at any rung, so the password and the key minted for that
// sign-in go when it does, not at their ten minutes.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Accounts, type FetchLike } from '../src/main/account-v2'

const PENDING = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Answers every sign-in with a ladder, then a landed session for any rung. */
const ladderOf = (pendings: readonly string[]): { accounts: Accounts; rungs: string[] } => {
  const base = mkdtempSync(path.join(tmpdir(), 'login-abandon-'))
  dirs.push(base)
  const queue = [...pendings]
  const rungs: string[] = []
  const http: FetchLike = async (input) => {
    const url = String(input)
    if (url.endsWith('/v2/sessions')) {
      const body = { error: 'second_factor', pending: queue.shift(), next: ['totp'], expiresAt: Date.now() + 600_000 }
      return new Response(JSON.stringify(body), { status: 401 })
    }
    rungs.push(url)
    return new Response(JSON.stringify({ token: 't', exp: Date.now() + 3_600_000, username: 'drej' }), { status: 201 })
  }
  return { accounts: new Accounts({ base, origin: 'http://127.0.0.1:1', fetch: http }), rungs }
}

describe('abandonSignIn', () => {
  it('forgets the password: a rung after it reaches nothing and files nothing', async () => {
    const { accounts, rungs } = ladderOf([PENDING])
    await accounts.signIn({ username: 'drej', password: 'correct-horse-battery' })
    accounts.abandonSignIn(PENDING)
    expect(await accounts.resumeWithCode(PENDING, 'totp', '123456')).toEqual({ ok: false, reason: 'expired' })
    expect(rungs).toEqual([])
    expect(accounts.account()).toBeNull()
  })

  it('leaves a sign-in begun since alone: it is not that ladder to end', async () => {
    const { accounts } = ladderOf([PENDING, OTHER])
    await accounts.signIn({ username: 'drej', password: 'correct-horse-battery' })
    await accounts.signIn({ username: 'drej', password: 'correct-horse-battery' })
    accounts.abandonSignIn(PENDING)
    expect(await accounts.resumeWithCode(OTHER, 'totp', '123456')).toMatchObject({ ok: true })
    expect(accounts.account()?.username).toBe('drej')
  })
})

describe('resumeWait with a signal', () => {
  it('stops at once, and the ladder is still standing for another rung', async () => {
    const { accounts } = ladderOf([PENDING])
    await accounts.signIn({ username: 'drej', password: 'correct-horse-battery' })
    const stop = new AbortController()
    stop.abort()
    expect(await accounts.resumeWait(PENDING, { signal: stop.signal })).toEqual({ ok: false, reason: 'expired' })
    expect(await accounts.resumeWithCode(PENDING, 'totp', '123456')).toMatchObject({ ok: true })
  })
})
