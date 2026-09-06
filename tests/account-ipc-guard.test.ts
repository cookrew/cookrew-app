// THE ACCOUNT'S IPC IS OWNER-ONLY, and "owner-only" has to mean the owner
// window's TOP FRAME — not "it is IPC, so nobody else can reach it".
//
// The app renders pages it did not author: browser cards host whatever the
// owner browsed to, an install page comes from a registry, a preset can ship a
// URL. Any of those reaching account:claim or account:recoveryCodes would be
// the listener hole in different clothes. So two things are checked here:
//
//   EVERY channel refuses a sender that is not the owner window's top frame.
//   THE CALL SITE in main registers them through the wrapper, not one by one.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isOwnerSender } from '../src/main/owner-grant'
import {
  ACCOUNT_CHANNELS,
  accountHandlers,
  accountStatus,
  registerAccountIpc,
  type AccountHandler,
  type AccountIpcDeps,
} from '../src/main/account-ipc'
import { IdleLock } from '../src/main/lock'
import { Accounts, DEFAULT_LOCK_AFTER_MS } from '../src/main/account-v2'
import { Approvals } from '../src/main/approvals'
import { Factors } from '../src/main/factors'

const OWNER = { id: 'owner-webcontents' }
const TOP = { parent: null }

/** No file, no socket: a local-only desktop, which is a supported state (P4). */
function deps(over: Partial<AccountIpcDeps> = {}): AccountIpcDeps {
  const accounts = new Accounts({
    base: path.join('/nonexistent-cookrew-test', String(Math.random())),
    origin: 'https://registry.test',
    fetch: () => Promise.reject(new Error('no network in this test')),
  })
  const base: AccountIpcDeps = {
    accounts,
    lock: new IdleLock({ lockAfterMs: DEFAULT_LOCK_AFTER_MS, verify: () => false }),
    // Never started: a poll on a test's clock is a socket nobody asked for.
    approvals: new Approvals({ accounts, notify: () => undefined }),
    factors: new Factors({ accounts, registry: 'https://registry.test' }),
    envUsername: null,
    workspaces: () => [],
    saveCodes: () => Promise.resolve({ ok: false, reason: 'no_window' }),
  }
  // Spread over a COMPLETE deps object, so an override cannot widen a field to
  // include undefined and quietly hand a handler nothing to call.
  return { ...base, ...over }
}

/** The wrapper main applies — restated here so the refusal is exercised. */
const ownerOnly =
  (op: AccountHandler) =>
  (event: { sender: unknown; senderFrame: { parent: unknown } | null }, ...args: unknown[]) => {
    if (!isOwnerSender(event.sender, event.senderFrame, OWNER)) {
      return { ok: false, reason: 'not_owner' }
    }
    return op(...args)
  }

describe('every account channel is registered, once, through the owner guard', () => {
  it('registers exactly the named set', () => {
    const seen: string[] = []
    registerAccountIpc((channel) => void seen.push(channel), deps())
    expect(seen).toEqual([...ACCOUNT_CHANNELS])
    expect(new Set(seen).size).toBe(ACCOUNT_CHANNELS.length)
  })

  it('REFUSES a browser card and an iframe on every one of them', () => {
    const handlers = accountHandlers(deps())
    for (const channel of ACCOUNT_CHANNELS) {
      const guarded = ownerOnly(handlers[channel])
      expect(guarded({ sender: { id: 'browser-card' }, senderFrame: TOP }, 'x')).toEqual({
        ok: false,
        reason: 'not_owner',
      })
      expect(guarded({ sender: OWNER, senderFrame: { parent: { id: 'top' } } }, 'x')).toEqual({
        ok: false,
        reason: 'not_owner',
      })
      expect(guarded({ sender: OWNER, senderFrame: null }, 'x')).toEqual({
        ok: false,
        reason: 'not_owner',
      })
    }
  })

  it('carries the phase 4 channels, and carries them through the same guard', () => {
    // The approval prompt and the factor ladder are the two surfaces that can
    // lock an account down and add a way into it. If either arrived on an
    // unguarded channel, a browser card could deny a sign-in the owner wanted
    // or enrol a factor they never saw.
    for (const channel of [
      'account:approvals',
      'account:decide',
      'account:setPassword',
      'account:factors',
      'account:totpEnrol',
      'account:totpConfirm',
      'account:totpRemove',
      'account:passkeys',
      'account:passkeyOptions',
      'account:passkeyAdd',
      'account:passkeyRemove',
    ]) {
      expect(ACCOUNT_CHANNELS).toContain(channel)
    }
  })

  it('main wires the account IPC through ownerOnly, not channel by channel', () => {
    // The one place a further channel could be added unguarded is the call
    // site. It takes a `register`, so the wrapper is applied by construction —
    // this asserts the call site still passes one that applies it.
    const source = readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    const call = /registerAccountIpc\(([\s\S]{0,220})/.exec(source)
    expect(call, 'index.ts must register the account IPC').not.toBeNull()
    expect(call?.[1]).toContain('ownerOnly')
    // And no account channel is handled anywhere else in main.
    expect(source).not.toMatch(/ipcMain\.(handle|on)\(\s*'account:/)
  })
})

describe('the status the owner window is given', () => {
  it('says NO ACCOUNT on a local-only desktop, and says it without an error', () => {
    const status = accountStatus(deps())
    expect(status.username).toBeNull()
    expect(status.locked).toBe(false)
    expect(status.lockAfterMs).toBe(DEFAULT_LOCK_AFTER_MS)
    expect(status.sessionExpired).toBe(false)
    expect(status.requests).toBe(0)
  })

  it('reports the env handle so a surface can say the two names differ', () => {
    expect(accountStatus(deps({ envUsername: 'drej' })).envUsername).toBe('drej')
  })

  it('NEVER carries key material or a token across the bridge', () => {
    const status = accountStatus(deps())
    const keys = Object.keys(status)
    expect(keys).not.toContain('privateKeyJwk')
    expect(keys).not.toContain('session')
    expect(keys).not.toContain('unlock')
  })

  it('reports whether the recovery codes were put away', () => {
    expect(accountStatus(deps()).recoveryCodesSavedAt).toBeNull()
  })
})

describe('the phase 4 handlers', () => {
  it('the status carries the live count of waiting devices, not a zero', () => {
    const shared = deps()
    vi.spyOn(shared.approvals, 'count', 'get').mockReturnValue(2)
    expect(accountStatus(shared).requests).toBe(2)
  })

  it('a decision answers with the STATUS, so the badge is right at once', async () => {
    const shared = deps()
    vi.spyOn(shared.approvals, 'decide').mockResolvedValue({ ok: true, value: undefined })
    const answer = (await accountHandlers(shared)['account:decide']({
      id: 'req-1',
      decision: 'approve',
    })) as { ok: true; value: { requests: number } }
    expect(shared.approvals.decide).toHaveBeenCalledWith('req-1', 'approve')
    expect(answer.ok).toBe(true)
    expect(answer.value.requests).toBe(0)
  })

  it('REFUSES a decision it does not recognise, rather than guessing one', async () => {
    const shared = deps()
    const decide = vi.spyOn(shared.approvals, 'decide')
    for (const decision of ['approve!', '', null, { decision: 'deny' }]) {
      await expect(
        accountHandlers(shared)['account:decide']({ id: 'req-1', decision }),
      ).resolves.toMatchObject({ ok: false })
    }
    expect(decide).not.toHaveBeenCalled()
  })

  it('coerces junk on every phase 4 channel instead of throwing at the bridge', async () => {
    const handlers = accountHandlers(deps())
    await expect(handlers['account:decide'](null)).resolves.toMatchObject({ ok: false })
    await expect(handlers['account:totpConfirm'](undefined)).resolves.toMatchObject({ ok: false })
    await expect(handlers['account:passkeyAdd'](7)).resolves.toMatchObject({ ok: false })
    await expect(handlers['account:passkeyRemove'](null)).resolves.toMatchObject({ ok: false })
    await expect(handlers['account:setPassword'](null)).resolves.toMatchObject({ ok: false })
  })

  it('carries the password through to BOTH factor removals', async () => {
    // The registry refuses a body-less DELETE with a sentence about a field
    // the card would never have shown. The channel has to be able to carry it.
    const shared = deps()
    const totp = vi.spyOn(shared.factors, 'removeTotp').mockResolvedValue({
      ok: true,
      value: undefined,
    })
    const passkey = vi.spyOn(shared.factors, 'removePasskey').mockResolvedValue({
      ok: true,
      value: undefined,
    })
    const handlers = accountHandlers(shared)
    await handlers['account:totpRemove']('correct-horse-battery')
    await handlers['account:passkeyRemove']('pk-1', 'correct-horse-battery')
    expect(totp).toHaveBeenCalledWith('correct-horse-battery')
    expect(passkey).toHaveBeenCalledWith('pk-1', 'correct-horse-battery')
  })

  it('a removal with no password never reaches the registry', async () => {
    const handlers = accountHandlers(deps())
    await expect(handlers['account:totpRemove'](undefined)).resolves.toMatchObject({ ok: false })
    await expect(handlers['account:passkeyRemove']('pk-1', null)).resolves.toMatchObject({
      ok: false,
    })
  })

  it('the approvals channel answers the polled list, opening no socket', () => {
    const shared = deps()
    expect(accountHandlers(shared)['account:approvals']()).toEqual([])
  })
})

describe('the handlers', () => {
  it('lock() locks and answers the status inside a result', async () => {
    const shared = deps()
    const handlers = accountHandlers(shared)
    expect(await handlers['account:lock']()).toMatchObject({
      ok: true,
      value: { locked: true },
    })
  })

  it('a channel that writes to the disk answers a SENTENCE, not a rejection', async () => {
    // Real-UI QA found a red box with no cause in it on the SECURITY tab. A
    // handler that throws rejects the invoke, and every rejection looked the
    // same by the time it reached the card.
    const shared = deps()
    vi.spyOn(shared.accounts, 'setLockAfterMs').mockImplementation(() => {
      throw new Error('EROFS: read-only file system')
    })
    const answer = (await accountHandlers(shared)['account:setLock'](0)) as {
      ok: false
      message: string
    }
    expect(answer.ok).toBe(false)
    expect(answer.message).toContain('The lock setting could not be saved on this Mac')
    expect(answer.message).toContain('EROFS')
  })

  it('keeps 0 as the OFF choice rather than reading it as a missing argument', async () => {
    const shared = deps()
    const setting = vi.spyOn(shared.accounts, 'setLockAfterMs')
    await accountHandlers(shared)['account:setLock'](0)
    expect(setting).toHaveBeenCalledWith(0)
    expect(shared.lock.lockAfterMs).toBe(0)
  })

  it('answers a sentence when the recovery codes cannot be made', async () => {
    const shared = deps()
    vi.spyOn(shared.accounts, 'recoveryCodes').mockRejectedValue(new Error('socket hang up'))
    const answer = (await accountHandlers(shared)['account:recoveryCodes']()) as {
      ok: false
      message: string
    }
    expect(answer).toMatchObject({ ok: false })
    expect(answer.message).toContain('New recovery codes could not be made')
    expect(answer.message).toContain('socket hang up')
  })

  it('setLock writes the setting to BOTH the file and the live timer', () => {
    const shared = deps()
    const setting = vi.spyOn(shared.accounts, 'setLockAfterMs')
    accountHandlers(shared)['account:setLock'](0)
    expect(setting).toHaveBeenCalledWith(0)
    expect(shared.lock.lockAfterMs).toBe(0)
  })

  it('check answers "invalid" for a name the rules refuse, with no network', async () => {
    expect(await accountHandlers(deps())['account:check']('Drej Smith')).toBe('invalid')
  })

  it('claim refuses a weak password before any socket, and never returns a key', async () => {
    const result = (await accountHandlers(deps())['account:claim']({
      username: 'drej',
      password: 'short',
    })) as { ok: boolean; reason: string }
    expect(result).toMatchObject({ ok: false, reason: 'weak_password' })
    expect(JSON.stringify(result)).not.toContain('privateKeyJwk')
  })

  it('a claim made while the app is running arms the approval poll', async () => {
    // The poll is armed at boot only when an account is already on disk, so a
    // Mac that claimed its name mid-session never heard the first phone ask to
    // sign in: the badge could not appear until a restart.
    const shared = deps()
    vi.spyOn(shared.accounts, 'claim').mockResolvedValue({
      ok: true,
      value: { lockAfterMs: DEFAULT_LOCK_AFTER_MS } as never,
    })
    vi.spyOn(shared.accounts, 'registerDesktop').mockResolvedValue({ ok: true, value: undefined })
    const started = vi.spyOn(shared.approvals, 'start')
    await accountHandlers(shared)['account:claim']({
      username: 'drej',
      password: 'a-long-enough-password',
    })
    expect(started).toHaveBeenCalled()
    shared.approvals.stop()
  })

  it('SAVE AS FILE takes no arguments — main writes the batch IT minted', async () => {
    // A channel that accepted text plus a path would write chosen bytes
    // wherever the owner happened to click. With nothing minted, there is
    // nothing to save and the dialog is never opened.
    const written: unknown[] = []
    const shared = deps({
      saveCodes: (codes) => {
        written.push(codes)
        return Promise.resolve({ ok: true })
      },
    })
    const handlers = accountHandlers(shared)
    expect(await handlers['account:saveRecoveryCodes']('/etc/passwd', 'anything')).toEqual({
      ok: false,
      reason: 'nothing_to_save',
    })
    expect(written).toEqual([])
  })

  it('records I SAVED THEM in the status it answers with', () => {
    const shared = deps()
    const marked = vi.spyOn(shared.accounts, 'markRecoveryCodesSaved')
    accountHandlers(shared)['account:codesSaved']()
    expect(marked).toHaveBeenCalled()
  })

  it('coerces junk arguments instead of throwing at the bridge', async () => {
    const handlers = accountHandlers(deps())
    await expect(handlers['account:check'](undefined)).resolves.toBe('invalid')
    await expect(handlers['account:claim'](null)).resolves.toMatchObject({ ok: false })
    expect(() => handlers['account:workspacesReachable']('yes please')).not.toThrow()
  })
})

/**
 * THE SEAT CHANNELS (phase 5) ride the same guard as everything else here —
 * they grant and revoke other people's access to this Mac's doors, so an
 * unguarded one is worse than an unguarded profile read. The set assertion at
 * the top of this file already covers "registered through ownerOnly"; these
 * cover what they answer, and that they answer rather than throw.
 */
describe('the seat channels', () => {
  const seatDeps = (over: Partial<AccountIpcDeps['seats']> = {}): AccountIpcDeps =>
    deps({
      seats: {
        door: null,
        serving: () => [],
        origin: 'https://registry.test',
        ...over,
      },
    })

  it('is in the named set, so the guard test above covers all four', () => {
    for (const channel of [
      'account:seats',
      'account:teamSeats',
      'account:grantSeat',
      'account:endSeat',
    ]) {
      expect(ACCOUNT_CHANNELS).toContain(channel)
    }
  })

  it('refuses with no_account on a desktop that never claimed a name', async () => {
    const handlers = accountHandlers(deps())
    for (const channel of [
      'account:seats',
      'account:teamSeats',
      'account:grantSeat',
      'account:endSeat',
    ] as const) {
      await expect(handlers[channel]({ slug: 'x', username: 'mira', id: 's' })).resolves.toEqual({
        ok: false,
        reason: 'no_account',
      })
    }
  })

  it('refuses a slug this Mac is not serving, without touching the registry', async () => {
    let asked = false
    const handlers = accountHandlers(
      seatDeps({
        door: {
          forTeam: async () => {
            asked = true
            return { ok: true, value: [] }
          },
        } as never,
      }),
    )
    await expect(handlers['account:teamSeats']('nobody')).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(asked).toBe(false)
  })

  it('refuses a served team that has no published name — it can hold no seats', async () => {
    const handlers = accountHandlers(
      seatDeps({
        door: {} as never,
        serving: () => [
          {
            serviceId: 'svc-a',
            slug: 'alpha',
            team: null,
            title: 'COOKREW Alpha',
            access: 'paid' as const,
            priceUsd: '1',
          },
        ],
      }),
    )
    await expect(handlers['account:teamSeats']('alpha')).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('grants and ends against the team the slug publishes as', async () => {
    const granted: string[] = []
    const ended: string[] = []
    const handlers = accountHandlers(
      seatDeps({
        door: {
          grant: async (team: string, username: string) => {
            granted.push(`${team}|${username}`)
            return { ok: true, value: { id: 'seat-1' } }
          },
          end: async (team: string, id: string) => {
            ended.push(`${team}|${id}`)
            return { ok: true, value: undefined }
          },
        } as never,
        serving: () => [
          {
            serviceId: 'svc-a',
            slug: 'alpha',
            team: '@drej/alpha',
            title: 'COOKREW Alpha',
            access: 'paid' as const,
            priceUsd: '1',
          },
        ],
      }),
    )
    await handlers['account:grantSeat']({ slug: 'alpha', username: 'mira' })
    await handlers['account:endSeat']({ slug: 'alpha', id: 'seat-1' })
    expect(granted).toEqual(['@drej/alpha|mira'])
    expect(ended).toEqual(['@drej/alpha|seat-1'])
  })

  it('coerces junk at the bridge instead of throwing', async () => {
    const handlers = accountHandlers(seatDeps({ door: {} as never }))
    await expect(handlers['account:grantSeat'](null)).resolves.toMatchObject({ ok: false })
    await expect(handlers['account:endSeat'](42)).resolves.toMatchObject({ ok: false })
    await expect(handlers['account:teamSeats'](undefined)).resolves.toMatchObject({ ok: false })
  })

  it('refuses an empty username before the registry can park a seat on nobody', async () => {
    const handlers = accountHandlers(
      seatDeps({
        door: {
          grant: async () => {
            throw new Error('must not be asked')
          },
        } as never,
        serving: () => [
          {
            serviceId: 'svc-a',
            slug: 'alpha',
            team: '@drej/alpha',
            title: 'A',
            access: 'account' as const,
          },
        ],
      }),
    )
    await expect(handlers['account:grantSeat']({ slug: 'alpha', username: '  ' })).resolves.toEqual(
      { ok: false, reason: 'bad_username' },
    )
  })
})
