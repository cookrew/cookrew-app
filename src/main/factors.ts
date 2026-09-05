import type { AccountResult } from '../shared/account-v2'
import type { FactorsView, PasskeySummary, TotpEnrolment } from '../shared/account-approvals'
import { qrMatrix } from './qr-matrix'

/**
 * THE SECOND FACTORS (D3/D4) — a passkey, an authenticator app, and the
 * account-wide flag that says the password has to change.
 *
 * WHAT THIS MODULE REFUSES TO DO IS THE POINT. Enrolling a factor is the one
 * place an app is tempted to be encouraging: show a tick, let the person get
 * on with their day, sort it out later. A factor that says ACTIVE without the
 * registry having confirmed a code is worse than no factor at all — it is the
 * owner believing they have a second way in, on the day they need one. So
 * every state here comes from the registry's answer and nothing is inferred
 * from a request having been sent.
 *
 * The same rule covers passkeys: this Electron may have no platform
 * authenticator, and when `navigator.credentials` refuses, the row says so
 * and offers the browser (D3's sentence). It never files a passkey the
 * registry did not accept.
 *
 * NOTHING IS LOGGED. The TOTP secret and the enrolment URI are handed to the
 * sheet that draws them and nowhere else; a console.error carrying an otpauth
 * URI is the second factor, in a log file.
 */

/** The one thing this module needs from `Accounts`: an authenticated call. */
export interface FactorsCaller {
  call<T>(pathname: string, init?: RequestInit & { parse?: boolean }): Promise<AccountResult<T>>
}

export interface FactorsDeps {
  accounts: FactorsCaller
  /** Where a browser goes to add a passkey: main knows the origin, not the UI. */
  registry: string
}

/** Six digits, and the sentence for anything else. */
const CODE = /^[0-9]{6}$/
const BAD_CODE = 'That is not a code from the app. Six digits, and they change every 30 seconds.'

/** GET /v2/me carries the factors; this is the slice of it we read. */
interface MeFactors {
  factors?: {
    totp?: boolean
    passkeys?: readonly PasskeySummary[]
    mustChangePassword?: boolean
  }
}

export class Factors {
  private readonly accounts: FactorsCaller
  private readonly registry: string

  constructor(deps: FactorsDeps) {
    this.accounts = deps.accounts
    this.registry = deps.registry
  }

  /**
   * What the Security tab draws itself from.
   *
   * A profile whose `factors` the registry did not send reads as NOTHING
   * ENROLLED rather than as an error: an older registry is a reason to offer
   * the ADD rows, not a reason for the tab to refuse to paint.
   */
  async view(): Promise<AccountResult<FactorsView>> {
    const result = await this.accounts.call<MeFactors>('/v2/me')
    if (!result.ok) return result
    const factors = result.value.factors
    return {
      ok: true,
      value: {
        totp: factors?.totp === true,
        passkeys: Array.isArray(factors?.passkeys) ? factors.passkeys : [],
        mustChangePassword: factors?.mustChangePassword === true,
        registry: this.registry,
      },
    }
  }

  async passkeys(): Promise<AccountResult<readonly PasskeySummary[]>> {
    const result = await this.view()
    return result.ok ? { ok: true, value: result.value.passkeys } : result
  }

  /**
   * Start an authenticator enrolment: a secret, its otpauth URI, and the QR.
   *
   * NOT ACTIVE YET, and the sheet says so — the factor exists on the account
   * only once `confirmTotp` has sent a code the registry accepted.
   */
  async enrolTotp(): Promise<AccountResult<TotpEnrolment>> {
    const result = await this.accounts.call<{ secret?: string; otpauth?: string }>(
      '/v2/me/totp/enrol',
      { method: 'POST' },
    )
    if (!result.ok) return result
    const { secret, otpauth } = result.value
    if (typeof secret !== 'string' || typeof otpauth !== 'string') {
      return { ok: false, reason: 'unknown' }
    }
    return { ok: true, value: { secret, otpauth, qr: qrMatrix(otpauth) } }
  }

  /** Confirm it with a code from the app. Shape is judged before the socket. */
  confirmTotp(code: string): Promise<AccountResult<void>> {
    if (!CODE.test(code.trim())) {
      return Promise.resolve({ ok: false, reason: 'bad_credentials', message: BAD_CODE })
    }
    return this.accounts.call<void>('/v2/me/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim() }),
      parse: false,
    })
  }

  removeTotp(): Promise<AccountResult<void>> {
    return this.accounts.call<void>('/v2/me/totp', { method: 'DELETE', parse: false })
  }

  /**
   * The creation options `navigator.credentials.create` needs.
   *
   * Handed straight to the renderer as the registry sent them: this app is
   * not a party to the WebAuthn ceremony, and re-shaping a challenge in the
   * middle of one is how a passkey ends up bound to the wrong thing.
   */
  passkeyOptions(): Promise<AccountResult<Record<string, unknown>>> {
    return this.accounts.call<Record<string, unknown>>('/v2/me/passkeys/options', {
      method: 'POST',
    })
  }

  addPasskey(input: {
    name: string
    credential: Record<string, unknown>
  }): Promise<AccountResult<PasskeySummary>> {
    const name = input.name.trim()
    if (name.length === 0) {
      return Promise.resolve({
        ok: false,
        reason: 'unknown',
        message: 'Give this passkey a name so you can tell it from the next one.',
      })
    }
    return this.accounts.call<PasskeySummary>('/v2/me/passkeys', {
      method: 'POST',
      body: JSON.stringify({ name, credential: input.credential }),
    })
  }

  removePasskey(id: string): Promise<AccountResult<void>> {
    if (id.length === 0) return Promise.resolve({ ok: false, reason: 'unknown' })
    return this.accounts.call<void>(`/v2/me/passkeys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      parse: false,
    })
  }

  /** Where a browser adds one when this Electron cannot (D3). */
  passkeyWebUrl(): string {
    return `${this.registry}/me#security`
  }
}
