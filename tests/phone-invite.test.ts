import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { mintPhoneInvite } from '../src/main/account-ipc'
import { handlePhoneInviteRoute, setPhoneInviter, type PhoneInviteRequest } from '../src/main/phone-invite'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, ipcMain: {}, shell: {} }))

/**
 * ⋯ → PHONE APP (owner 2026-11-16): a QR the native phone app scans to join the
 * account as a trusted phone. Minted under the account's step-up, only by the
 * owner, only over a sealed line.
 */

type Deps = Parameters<typeof mintPhoneInvite>[0]

const deps = (over: Record<string, unknown> = {}, locked = false): Deps =>
  ({
    lock: { locked },
    accounts: {
      account: () => ({ username: 'drej' }),
      isPasswordless: () => false,
      providerProve: vi.fn(async () => ({ ok: true, value: 'climbed' })),
      mintJoinCode: vi.fn(async () => ({ ok: true, value: { code: 'K7QM-2XPD', expiresAt: 9, url: 'https://cookrew.dev/join#K7QM-2XPD' } })),
      ...over
    }
  }) as unknown as Deps

describe('a code for the phone app, as main mints it', () => {
  it('spends the password the sheet took, for a phone’s code, and hands back the code, its end and its link', async () => {
    const d = deps()
    expect(await mintPhoneInvite(d, 'pw', true)).toEqual({ ok: true, code: 'K7QM-2XPD', expiresAt: 9, url: 'https://cookrew.dev/join#K7QM-2XPD' })
    // A phone's code: the only code a trusted phone is made by (registry v2-join.ts).
    expect(d.accounts.mintJoinCode).toHaveBeenCalledWith('pw', 'phone')
  })

  it('says so when this Mac has no account', async () => {
    expect(await mintPhoneInvite(deps({ account: () => null }), 'pw', true)).toEqual({ ok: false, reason: 'no_account' })
  })

  it('never opens a provider trip on the Mac for someone holding a phone', async () => {
    const d = deps({ isPasswordless: () => true })
    expect(await mintPhoneInvite(d, '', false)).toEqual({ ok: false, reason: 'provider_required' })
    expect(d.accounts.providerProve).not.toHaveBeenCalled()
  })

  it('takes the provider trip when asked on the Mac itself', async () => {
    const d = deps({ isPasswordless: () => true })
    expect((await mintPhoneInvite(d, '', true)).ok).toBe(true)
    expect(d.accounts.mintJoinCode).toHaveBeenCalledWith({ stepUp: 'climbed' }, 'phone')
  })

  it('carries the refusal through in the registry reason words', async () => {
    const d = deps({ mintJoinCode: async () => ({ ok: false, reason: 'bad_credentials', message: 'no' }) })
    expect(await mintPhoneInvite(d, 'pw', false)).toEqual({ ok: false, reason: 'bad_credentials', message: 'no' })
  })
})

describe('POST /api/phone/invite', () => {
  const answer = () => {
    const written: { status?: number; body?: string } = {}
    const response = {
      writeHead: (status: number) => {
        written.status = status
        return response
      },
      setHeader: () => response,
      end: (body?: string) => {
        written.body = body
      }
    }
    return { written, response }
  }

  const ask = async (over: Partial<PhoneInviteRequest> & { body?: unknown }) => {
    const { written, response } = answer()
    const payload = JSON.stringify(over.body ?? { current: 'pw' })
    const request = Object.assign(Readable.from([Buffer.from(payload)]), { headers: { 'content-type': 'application/json' } })
    const handled = await handlePhoneInviteRoute({
      request: request as never,
      response: response as never,
      method: 'POST',
      path: '/api/phone/invite',
      owner: true,
      sealed: () => true,
      ...over
    })
    return { handled, status: written.status, body: written.body ? JSON.parse(written.body) : null }
  }

  it('mints for the owner over a sealed line, never by a provider trip on the Mac', async () => {
    const mint = vi.fn(async () => ({ ok: true as const, code: 'K7QM-2XPD', expiresAt: 9, url: 'https://cookrew.dev/join#K7QM-2XPD' }))
    setPhoneInviter(mint)
    const out = await ask({})
    expect(out).toMatchObject({ handled: true, status: 200, body: { ok: true, code: 'K7QM-2XPD' } })
    expect(mint).toHaveBeenCalledWith('pw', false)
  })

  it('a device that is not the owner gets nothing, and nothing is minted', async () => {
    const mint = vi.fn()
    setPhoneInviter(mint)
    const out = await ask({ owner: false })
    expect(out.status).toBe(401)
    expect(mint).not.toHaveBeenCalled()
  })

  it('on a plain line the password is never read: the code is not minted', async () => {
    const mint = vi.fn()
    setPhoneInviter(mint)
    const out = await ask({ sealed: () => false })
    expect(out.body).toEqual({ ok: false, reason: 'not_sealed' })
    expect(mint).not.toHaveBeenCalled()
  })

  it('a body that is not JSON is refused, and nothing is minted', async () => {
    const mint = vi.fn()
    setPhoneInviter(mint)
    const { written, response } = answer()
    const request = Object.assign(Readable.from([Buffer.from('{not json')]), { headers: {} })
    await handlePhoneInviteRoute({ request: request as never, response: response as never, method: 'POST', path: '/api/phone/invite', owner: true, sealed: () => true })
    expect(written.status).toBe(400)
    expect(mint).not.toHaveBeenCalled()
  })

  it('a minter that throws is an unknown refusal, not a crash', async () => {
    setPhoneInviter(async () => {
      throw new Error('down')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect((await ask({})).body).toEqual({ ok: false, reason: 'unknown' })
    errors.mockRestore()
  })

  it('answers only its own route', async () => {
    setPhoneInviter(vi.fn())
    expect((await ask({ method: 'GET' })).handled).toBe(false)
    expect((await ask({ path: '/api/phone/other' })).handled).toBe(false)
  })

  it('says so when main has not wired it', async () => {
    setPhoneInviter(null)
    expect((await ask({})).status).toBe(503)
  })
})
