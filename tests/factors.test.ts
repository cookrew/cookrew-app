// THE SECOND FACTORS (D3) — and the one property worth more than all the
// wiring: nothing here ever reports a factor the registry did not confirm.
//
// An enrolment that showed ACTIVE on the strength of having asked would leave
// an owner believing they hold a second way into their account, on the day
// they need one. So the tests below check the wire (which path, which body)
// and then check the refusals: a code that is not six digits never reaches a
// socket, a passkey the browser refused to create is never filed, and a
// registry that answers no leaves the row exactly as it was.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Factors } from '../src/main/factors'
import { qrMatrix } from '../src/main/qr-matrix'
import type { AccountResult } from '../src/shared/account-v2'

const OTPAUTH =
  'otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30'

interface Harness {
  factors: Factors
  calls: { path: string; init?: RequestInit & { parse?: boolean } }[]
  setAnswer: (fn: (path: string) => AccountResult<unknown>) => void
}

function harness(): Harness {
  const calls: Harness['calls'] = []
  let answer: (path: string) => AccountResult<unknown> = () => ({ ok: true, value: {} })
  const factors = new Factors({
    accounts: {
      call: <T>(path: string, init?: RequestInit & { parse?: boolean }) => {
        calls.push({ path, ...(init ? { init } : {}) })
        return Promise.resolve(answer(path) as AccountResult<T>)
      },
    },
    registry: 'https://registry.test',
  })
  return {
    factors,
    calls,
    setAnswer: (fn) => {
      answer = fn
    },
  }
}

describe('what the Security tab reads', () => {
  it('carries totp, the passkeys, the password flag and where to add one', async () => {
    const h = harness()
    h.setAnswer(() => ({
      ok: true,
      value: {
        username: 'drej',
        factors: {
          totp: true,
          passkeys: [{ id: 'pk-1', name: 'Touch ID on this Mac', addedAt: 1 }],
          mustChangePassword: true,
        },
      },
    }))
    const view = await h.factors.view()
    expect(h.calls[0].path).toBe('/v2/me')
    expect(view).toEqual({
      ok: true,
      value: {
        totp: true,
        passkeys: [{ id: 'pk-1', name: 'Touch ID on this Mac', addedAt: 1 }],
        mustChangePassword: true,
        registry: 'https://registry.test',
      },
    })
  })

  it('ASKS /v2/me/factors when /v2/me did not carry them', async () => {
    // The registry has a dedicated route for the posture, and reading its
    // absence from /v2/me as "nothing enrolled" is how the card offers ADD AN
    // AUTHENTICATOR to an account that already has one — and stays silent
    // about a password the registry is demanding be changed.
    const h = harness()
    h.setAnswer((path) =>
      path === '/v2/me'
        ? { ok: true, value: { username: 'drej' } }
        : { ok: true, value: { totp: true, passkeys: [], mustChangePassword: true } },
    )
    const view = await h.factors.view()
    expect(h.calls.map((call) => call.path)).toEqual(['/v2/me', '/v2/me/factors'])
    expect(view).toMatchObject({ ok: true, value: { totp: true, mustChangePassword: true } })
  })

  it('takes /v2/me\'s own factors when it sends them, and asks nothing more', async () => {
    const h = harness()
    h.setAnswer(() => ({
      ok: true,
      value: { username: 'drej', factors: { totp: false, passkeys: [] } },
    }))
    await h.factors.view()
    expect(h.calls.map((call) => call.path)).toEqual(['/v2/me'])
  })

  it('reads a registry with no factor route at all as NOTHING ENROLLED', async () => {
    // 404 there means a registry with no phase 4: an empty ladder is the
    // truth, not a guess. Any other refusal is passed through below.
    const h = harness()
    h.setAnswer((path) =>
      path === '/v2/me' ? { ok: true, value: { username: 'drej' } } : { ok: false, reason: 'unknown' },
    )
    await expect(h.factors.view()).resolves.toMatchObject({
      ok: true,
      value: { totp: false, passkeys: [], mustChangePassword: false },
    })
  })

  it('passes a session refusal from the factor route through', async () => {
    const h = harness()
    h.setAnswer((path) =>
      path === '/v2/me'
        ? { ok: true, value: { username: 'drej' } }
        : { ok: false, reason: 'session-expired' },
    )
    await expect(h.factors.view()).resolves.toMatchObject({
      ok: false,
      reason: 'session-expired',
    })
  })

  it('passes a refusal through instead of inventing a state', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: false, reason: 'session-expired' }))
    await expect(h.factors.view()).resolves.toMatchObject({ ok: false, reason: 'session-expired' })
    await expect(h.factors.passkeys()).resolves.toMatchObject({ ok: false })
  })
})

describe('the authenticator app', () => {
  it('enrols, and hands back the secret, the URI and a QR of the URI', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: { secret: 'JBSWY3DPEHPK3PXP', otpauth: OTPAUTH } }))
    const result = await h.factors.enrolTotp()
    expect(h.calls[0]).toMatchObject({ path: '/v2/me/totp/enrol' })
    expect(h.calls[0].init?.method).toBe('POST')
    if (!result.ok) throw new Error('enrolment should have succeeded')
    expect(result.value.secret).toBe('JBSWY3DPEHPK3PXP')
    expect(result.value.qr).toEqual(qrMatrix(OTPAUTH))
    expect(result.value.qr.length).toBeGreaterThan(20)
  })

  it('refuses an answer without a secret rather than drawing an empty QR', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: { otpauth: OTPAUTH } }))
    await expect(h.factors.enrolTotp()).resolves.toMatchObject({ ok: false, reason: 'unknown' })
  })

  it('confirms with six digits, and the code goes in the body', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: undefined }))
    await expect(h.factors.confirmTotp(' 123456 ')).resolves.toEqual({ ok: true, value: undefined })
    expect(h.calls[0].path).toBe('/v2/me/totp/confirm')
    expect(h.calls[0].init?.body).toBe('{"code":"123456"}')
    expect(h.calls[0].init?.parse).toBe(false)
  })

  it('never sends anything that is not six digits, and says why', async () => {
    const h = harness()
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      const result = await h.factors.confirmTotp(code)
      expect(result).toMatchObject({ ok: false })
      expect(result.ok ? '' : result.message).toContain('Six digits')
    }
    expect(h.calls).toHaveLength(0)
  })

  it('removes with a DELETE that CARRIES THE PASSWORD, as the registry gates it', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: undefined }))
    await h.factors.removeTotp('correct-horse-battery')
    expect(h.calls[0]).toMatchObject({ path: '/v2/me/totp' })
    expect(h.calls[0].init?.method).toBe('DELETE')
    expect(h.calls[0].init?.body).toBe('{"current":"correct-horse-battery"}')
    expect(h.calls[0].init?.parse).toBe(false)
  })

  it('does not send a removal with no password — the refusal is the sentence', async () => {
    const h = harness()
    const result = await h.factors.removeTotp('')
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.message).toBe(
      'Type your password to take a factor off the account.',
    )
    expect(h.calls).toHaveLength(0)
  })
})

describe('passkeys', () => {
  it('asks for creation options and hands them over untouched', async () => {
    const h = harness()
    const options = { challenge: 'AAAA', rp: { id: 'registry.test' }, user: { name: 'drej' } }
    h.setAnswer(() => ({ ok: true, value: options }))
    const result = await h.factors.passkeyOptions()
    expect(h.calls[0]).toMatchObject({ path: '/v2/me/passkeys/options' })
    expect(h.calls[0].init?.method).toBe('POST')
    // Untouched: this app is not a party to the ceremony.
    expect(result).toEqual({ ok: true, value: options })
  })

  it('files a credential the browser produced, under a name', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: { id: 'pk-2', name: 'Touch ID', addedAt: 2 } }))
    await h.factors.addPasskey({ name: 'Touch ID', credential: { id: 'abc', type: 'public-key' } })
    expect(h.calls[0].path).toBe('/v2/me/passkeys')
    expect(h.calls[0].init?.body).toBe(
      '{"name":"Touch ID","credential":{"id":"abc","type":"public-key"}}',
    )
  })

  it('refuses a nameless passkey before the socket', async () => {
    const h = harness()
    await expect(
      h.factors.addPasskey({ name: '  ', credential: { id: 'abc' } }),
    ).resolves.toMatchObject({ ok: false })
    expect(h.calls).toHaveLength(0)
  })

  it('removes one by id, escaped, with the password in the body', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: undefined }))
    await h.factors.removePasskey('pk 2/3', 'correct-horse-battery')
    expect(h.calls[0].path).toBe('/v2/me/passkeys/pk%202%2F3')
    expect(h.calls[0].init?.method).toBe('DELETE')
    expect(h.calls[0].init?.body).toBe('{"current":"correct-horse-battery"}')
    await expect(h.factors.removePasskey('', 'correct-horse-battery')).resolves.toMatchObject({
      ok: false,
    })
    // Neither a missing id nor a missing password reaches the socket.
    await expect(h.factors.removePasskey('pk-1', '')).resolves.toMatchObject({ ok: false })
    expect(h.calls).toHaveLength(1)
  })

  it('points a browser at THIS registry, not at cookrew.dev by assumption', () => {
    expect(harness().factors.passkeyWebUrl()).toBe('https://registry.test/me#security')
  })
})

describe('the QR the enrolment sheet draws', () => {
  const rows = qrMatrix(OTPAUTH)

  it('is square, and big enough to hold an otpauth URI', () => {
    expect(rows.length).toBeGreaterThanOrEqual(29)
    for (const row of rows) expect(row).toHaveLength(rows.length)
    expect(rows.join('')).toMatch(/^[01]+$/)
  })

  it('carries the three finder patterns, which is what a camera looks for', () => {
    const size = rows.length
    const finder = (top: number, left: number): string =>
      rows
        .slice(top, top + 7)
        .map((row) => row.slice(left, left + 7))
        .join('')
    const expected = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']
    expect(finder(0, 0)).toBe(expected.join(''))
    expect(finder(0, size - 7)).toBe(expected.join(''))
    expect(finder(size - 7, 0)).toBe(expected.join(''))
  })

  it('imports the encoder BY FILE — a directory import boots into a crash', () => {
    // Vitest resolves `vendor/QRCode` happily; Node's ESM resolver, which is
    // what runs the built main, throws ERR_UNSUPPORTED_DIR_IMPORT. The bug
    // therefore cannot appear in any test that merely calls qrMatrix.
    const source = readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'qr-matrix.ts'),
      'utf8',
    )
    const imports = source.match(/from '[^']+'/g) ?? []
    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) expect(specifier).toMatch(/\.js'$/)
  })

  it('is deterministic, and different for different data', () => {
    expect(qrMatrix(OTPAUTH)).toEqual(rows)
    expect(qrMatrix(`${OTPAUTH}&x=1`)).not.toEqual(rows)
    expect(qrMatrix('')).toEqual([])
  })
})
