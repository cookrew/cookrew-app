import type { AccountResult } from '../shared/account-v2'
import {
  APPROVAL_COPY,
  type FactorsView,
  type PasskeySummary,
  type TotpEnrolment,
} from '../shared/account-approvals'
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
 * TAKING A FACTOR OFF COSTS THE PASSWORD, and the app has to know that before
 * the socket. The registry gates both removals on `{current}` — deleting the
 * thing that protects a password must not be cheaper than changing it — so a
 * body-less DELETE is not a stricter server refusing a legal request, it is
 * this app sending an incomplete one and then showing the owner a refusal
 * they cannot act on.
 *
 * NOTHING IS LOGGED. The TOTP secret, the enrolment URI and the password that
 * removes a factor are handed to the call that needs them and nowhere else; a
 * console.error carrying an otpauth URI is the second factor, in a log file.
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

/** The posture, however it arrived: inside /v2/me, or from /v2/me/factors. */
interface FactorSummary {
  totp?: boolean
  passkeys?: readonly PasskeySummary[]
  mustChangePassword?: boolean
}

/** GET /v2/me carries the factors when the registry is new enough. */
interface MeFactors {
  factors?: FactorSummary
}

const summaryOf = (summary: FactorSummary | undefined, registry: string): FactorsView => ({
  totp: summary?.totp === true,
  passkeys: Array.isArray(summary?.passkeys) ? summary.passkeys : [],
  mustChangePassword: summary?.mustChangePassword === true,
  registry,
})

/** The refusal for a removal with no password — the registry's own sentence. */
const needsPassword = (): AccountResult<void> => ({
  ok: false,
  reason: 'bad_credentials',
  message: APPROVAL_COPY.REMOVE_NEEDS_PASSWORD,
})

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
   * TWO PLACES, ONE ANSWER. /v2/me carries `factors` on a registry that is
   * new enough; where it does not, the posture lives at /v2/me/factors and is
   * ASKED FOR rather than assumed away. Reading an absent field as "nothing
   * enrolled" is the failure this method exists to avoid: a card that offers
   * ADD AN AUTHENTICATOR to an account that already has one, and stays silent
   * about a password the registry is demanding be changed.
   *
   * Only a registry with no phase 4 at all — a 404 on the dedicated route —
   * reads as nothing enrolled, because for that one there is nothing to
   * enrol yet, and an empty ladder is the truth rather than a guess.
   */
  async view(): Promise<AccountResult<FactorsView>> {
    const result = await this.accounts.call<MeFactors>('/v2/me')
    if (!result.ok) return result
    if (result.value.factors !== undefined) {
      return { ok: true, value: summaryOf(result.value.factors, this.registry) }
    }
    const summary = await this.accounts.call<FactorSummary>('/v2/me/factors')
    if (summary.ok) return { ok: true, value: summaryOf(summary.value, this.registry) }
    if (summary.reason === 'unknown') {
      return { ok: true, value: summaryOf(undefined, this.registry) }
    }
    return summary
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

  /**
   * Take the authenticator off — with the password, which the registry gates
   * this on. A DELETE with a body is unusual and it is the contract.
   */
  removeTotp(current: string): Promise<AccountResult<void>> {
    if (current.length === 0) return Promise.resolve(needsPassword())
    return this.accounts.call<void>('/v2/me/totp', {
      method: 'DELETE',
      body: JSON.stringify({ current }),
      parse: false,
    })
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

  removePasskey(id: string, current: string): Promise<AccountResult<void>> {
    if (id.length === 0) return Promise.resolve({ ok: false, reason: 'unknown' })
    if (current.length === 0) return Promise.resolve(needsPassword())
    return this.accounts.call<void>(`/v2/me/passkeys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ current }),
      parse: false,
    })
  }

  /** Where a browser adds one when this Electron cannot (D3). */
  passkeyWebUrl(): string {
    return `${this.registry}/me#security`
  }
}
