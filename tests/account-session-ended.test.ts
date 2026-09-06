// A SESSION CAN DIE WITHOUT THE CLOCK RUNNING OUT.
//
// The live bug: the owner changed their password on cookrew.dev, which by
// design ended every other session including this Mac's. Every authed call
// then answered 401 unauthenticated — but `sessionLive()` was derived from the
// token's `exp` alone, so `status.sessionExpired` stayed FALSE, the surface
// never opened its password prompt, and the sentence "Your session ended. Type
// your password once and this carries on." appeared with nowhere to type it.
//
// Temp dirs only; `fetch` is injected, so no socket is opened and no real
// ~/.cookrew is touched. No password or token value is ever asserted on.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Accounts, loadAccount, writeAccount } from '../src/main/account-v2'
import { accountStatus } from '../src/main/account-ipc'
import { IdleLock } from '../src/main/lock'
import { Approvals } from '../src/main/approvals'
import { fakeAccount, tempBase } from './support/idv2'

const OLD_PASSWORD = 'the-old-passphrase'
const NEW_PASSWORD = 'the-new-passphrase'
const ORIGIN = 'https://registry.test'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean()
})

/** A base holding an account whose token is nowhere near expiry. */
function claimed(): string {
  const { base, clean } = tempBase()
  cleanups.push(clean)
  writeAccount(
    fakeAccount({
      registry: ORIGIN,
      // HOURS LEFT on the clock. This is the whole point: nothing about `exp`
      // says this token is finished, and it is.
      session: { token: 'session-token', exp: Date.now() + 3_600_000 },
    }),
    base,
  )
  return base
}

/** A fetch that answers a scripted list and records the calls. */
function scripted(replies: readonly { status: number; body?: unknown }[]): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  urls: string[]
} {
  const urls: string[] = []
  let index = 0
  return {
    urls,
    fetch: (url) => {
      urls.push(url)
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      const body =
        reply.status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body)
      return Promise.resolve(
        new Response(body, {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    },
  }
}

const accountsAt = (
  base: string,
  replies: readonly { status: number; body?: unknown }[],
  onChange?: () => void,
): { it: Accounts; urls: string[] } => {
  const script = scripted(replies)
  return {
    it: new Accounts({
      base,
      origin: ORIGIN,
      fetch: script.fetch,
      ...(onChange ? { onChange } : {}),
    }),
    urls: script.urls,
  }
}

const UNAUTHENTICATED = { status: 401, body: { error: 'unauthenticated' } }

describe('a 401 unauthenticated ends the session, and it is written down', () => {
  it('flips sessionLive BEFORE the refusal is even returned', async () => {
    const base = claimed()
    const { it } = accountsAt(base, [UNAUTHENTICATED])
    expect(it.sessionLive()).toBe(true)
    expect(await it.profile()).toMatchObject({ ok: false, reason: 'session-expired' })
    expect(it.sessionLive()).toBe(false)
  })

  it('PERSISTS the refusal, so a restart does not believe the token again', async () => {
    const base = claimed()
    const { it } = accountsAt(base, [UNAUTHENTICATED])
    await it.profile()
    expect(loadAccount(base)?.session?.endedAt).toBeGreaterThan(0)
    // A fresh Accounts over the same file agrees — which is what a relaunched
    // app is.
    const restarted = accountsAt(base, [UNAUTHENTICATED]).it
    expect(restarted.sessionLive()).toBe(false)
  })

  it('turns status.sessionExpired TRUE — the flag the surface reads', async () => {
    const base = claimed()
    const { it } = accountsAt(base, [UNAUTHENTICATED])
    const deps = {
      accounts: it,
      lock: new IdleLock({ lockAfterMs: 0, verify: () => false }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false }),
      approvals: { count: 0 },
      factors: null,
    } as unknown as Parameters<typeof accountStatus>[0]
    expect(accountStatus(deps).sessionExpired).toBe(false)
    await it.profile()
    expect(accountStatus(deps).sessionExpired).toBe(true)
  })

  it('BROADCASTS, so a surface nobody clicked finds out', async () => {
    // The password was changed on another machine. No click on this Mac would
    // ever reveal it; the push is the only thing that can.
    const base = claimed()
    const changes = vi.fn()
    const { it } = accountsAt(base, [UNAUTHENTICATED], changes)
    await it.profile()
    expect(changes).toHaveBeenCalled()
  })

  it('records it ONCE, not on every refused call', async () => {
    const base = claimed()
    const changes = vi.fn()
    const { it } = accountsAt(base, [UNAUTHENTICATED], changes)
    await it.profile()
    const first = loadAccount(base)?.session?.endedAt
    changes.mockClear()
    await it.profile()
    expect(loadAccount(base)?.session?.endedAt).toBe(first)
    expect(changes).not.toHaveBeenCalled()
  })

  it('does NOT end the session for a 401 that named something else', async () => {
    // A mistyped authenticator code and a refused passkey are also 401s. Telling
    // the owner "your session ended" for those sends them to the wrong fix.
    const base = claimed()
    const { it } = accountsAt(base, [{ status: 401, body: { error: 'bad_credentials' } }])
    await it.setPassword({ current: 'wrong-one-here', next: NEW_PASSWORD })
    expect(it.sessionLive()).toBe(true)
    expect(loadAccount(base)?.session?.endedAt).toBeUndefined()
  })
})

describe('nothing keeps hammering a session cookrew.dev threw away', () => {
  it('short-circuits every authed call without opening a socket', async () => {
    const base = claimed()
    const { it, urls } = accountsAt(base, [UNAUTHENTICATED])
    await it.profile()
    expect(urls).toHaveLength(1)
    await it.profile()
    await it.devices()
    await it.registerDesktop([])
    expect(urls).toHaveLength(1)
  })

  it('empties the approval badge instead of polling for it', async () => {
    const base = claimed()
    const { it, urls } = accountsAt(base, [UNAUTHENTICATED])
    const approvals = new Approvals({
      accounts: it,
      notify: () => undefined,
      pollMs: 10_000,
    })
    await it.profile()
    await approvals.refresh()
    await approvals.refresh()
    // Only the profile call ever left; the badge is a request the owner can no
    // longer act on, so it goes to zero rather than being asked about.
    expect(urls).toHaveLength(1)
    expect(approvals.count).toBe(0)
  })
})

describe('resume trades the password for a new session', () => {
  const LIVE = {
    status: 201,
    body: { token: 'fresh-token', exp: Date.now() + 3_600_000, deviceId: 'd' },
  }

  it('clears the refusal and brings sessionLive back', async () => {
    const base = claimed()
    const { it } = accountsAt(base, [UNAUTHENTICATED, LIVE])
    await it.profile()
    expect(it.sessionLive()).toBe(false)
    expect(await it.resume(NEW_PASSWORD)).toMatchObject({ ok: true })
    expect(it.sessionLive()).toBe(true)
    expect(loadAccount(base)?.session?.endedAt).toBeUndefined()
  })

  it('re-signs in with the EXISTING device — no ladder, it is still attached', async () => {
    const base = claimed()
    const script = scripted([UNAUTHENTICATED, LIVE])
    const sent: RequestInit[] = []
    const it = new Accounts({
      base,
      origin: ORIGIN,
      fetch: (url, init) => {
        sent.push(init ?? {})
        return script.fetch(url, init)
      },
    })
    await it.profile()
    await it.resume(NEW_PASSWORD)
    const body = JSON.parse(String(sent[1].body)) as {
      device: { id: string; kind: string; jwk: unknown }
    }
    expect(body.device.id).toBe(loadAccount(base)?.deviceId)
    expect(body.device.kind).toBe('desktop')
    expect(body.device.jwk).toBeTruthy()
  })

  it('RE-DERIVES the local unlock verifier from the password that worked', async () => {
    // The other half of the live bug. The password was changed on the web, so
    // the verifier in this file still holds the OLD one: the new password
    // fails offline, the old one fails at the registry, and no password opens
    // both. cookrew.dev has just proved this one — so it unlocks the app too.
    const base = claimed()
    const { it } = accountsAt(base, [UNAUTHENTICATED, LIVE])
    await it.profile()
    expect(it.verifyUnlock(NEW_PASSWORD)).toBe(false)
    await it.resume(NEW_PASSWORD)
    expect(it.verifyUnlock(NEW_PASSWORD)).toBe(true)
    expect(it.verifyUnlock(OLD_PASSWORD)).toBe(false)
  })

  it('leaves the session dead when the password is refused', async () => {
    const base = claimed()
    const { it } = accountsAt(base, [
      UNAUTHENTICATED,
      { status: 401, body: { error: 'bad_credentials' } },
    ])
    await it.profile()
    expect(await it.resume('not-the-password')).toMatchObject({
      ok: false,
      reason: 'session-expired',
    })
    expect(it.sessionLive()).toBe(false)
  })

  it('names a second factor rather than blaming the password', async () => {
    const base = claimed()
    const { it } = accountsAt(base, [
      UNAUTHENTICATED,
      { status: 401, body: { error: 'second_factor' } },
    ])
    await it.profile()
    expect(await it.resume(NEW_PASSWORD)).toMatchObject({ ok: false, reason: 'second_factor' })
  })
})
