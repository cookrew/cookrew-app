import { describe, expect, it, vi } from 'vitest'
import { mintWatchInvite } from '../src/main/account-ipc'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, ipcMain: {}, shell: {} }))

type Deps = Parameters<typeof mintWatchInvite>[0]

const deps = (over: Record<string, unknown> = {}, locked = false): Deps =>
  ({
    lock: { locked },
    accounts: {
      account: () => ({ username: 'drej' }),
      isPasswordless: () => false,
      providerProve: vi.fn(async () => ({ ok: true, value: 'climbed' })),
      mintJoinCode: vi.fn(async () => ({ ok: true, value: { code: 'K7QM-2XPD', expiresAt: 9, url: 'u' } })),
      ...over
    }
  }) as unknown as Deps

describe('a code for a watch, as main mints it', () => {
  it('spends the password the sheet took, and hands back only the code and its end', async () => {
    const d = deps()
    expect(await mintWatchInvite(d, 'pw', false)).toEqual({ ok: true, code: 'K7QM-2XPD', expiresAt: 9 })
    expect(d.accounts.mintJoinCode).toHaveBeenCalledWith('pw')
  })

  it('says so when this Mac has no account', async () => {
    expect(await mintWatchInvite(deps({ account: () => null }), 'pw', true)).toEqual({ ok: false, reason: 'no_account' })
  })

  it('never opens a provider trip on the Mac for someone holding a phone', async () => {
    const d = deps({ isPasswordless: () => true })
    expect(await mintWatchInvite(d, '', false)).toEqual({ ok: false, reason: 'provider_required' })
    expect(d.accounts.providerProve).not.toHaveBeenCalled()
  })

  it('takes the provider trip when asked on the Mac itself', async () => {
    const d = deps({ isPasswordless: () => true })
    expect((await mintWatchInvite(d, '', true)).ok).toBe(true)
    expect(d.accounts.mintJoinCode).toHaveBeenCalledWith({ stepUp: 'climbed' })
  })

  it('carries the refusal through in the registry reason words', async () => {
    const d = deps({ mintJoinCode: async () => ({ ok: false, reason: 'bad_credentials', message: 'no' }) })
    expect(await mintWatchInvite(d, 'pw', false)).toEqual({ ok: false, reason: 'bad_credentials', message: 'no' })
  })

  it('a locked Mac mints nothing by provider', async () => {
    const d = deps({ isPasswordless: () => true }, true)
    expect(await mintWatchInvite(d, '', true)).toEqual({ ok: false, reason: 'locked' })
  })
})
