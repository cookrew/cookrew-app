import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { StoredPasskey } from './v2-passkeys'
import { mintTotpSecret, otpauthUrl, totpStepFor } from './v2-totp'

/**
 * IDENTITY v2 — WHAT AN ACCOUNT HAS BESIDES A PASSWORD.
 *
 * Passkeys, an authenticator secret, and the one flag "not me" sets. Kept in
 * its own file beside the accounts rather than inside them, for two reasons
 * that both matter more than the tidiness of one record:
 *
 *   · a factor is a SECRET (a TOTP seed is a bearer token for the code), and
 *     keeping it out of the file that is read on every profile render keeps
 *     the blast radius of any future "just log the account" small;
 *   · phase 4 lands beside phases 2 and 5 in the same week, and a store
 *     nobody else edits is a store nobody else has to merge.
 *
 * A username here is never created on its own: the account file is the
 * authority for who exists, and this file only ever describes accounts it
 * names.
 */

export const FACTORS_FILE = 'factors-v2.json'

/** Twenty is more keys than a person owns, and a ceiling a stranger cannot spend. */
const PASSKEYS_MAX = 20
const NAME_MAX = 64

export interface TotpState {
  /** base32, as an authenticator app was given it. */
  secret: string
  /** False until a code proves the phone actually holds the secret. */
  active: boolean
  addedAt: number
  /**
   * The last thirty-second step this account signed in with.
   *
   * A code is good for ninety seconds, which is ninety seconds in which one
   * read over a shoulder — or relayed by a page pretending to be us while
   * the owner's own attempt succeeds — is still good. RFC 6238 §5.2 says a
   * verifier must not accept the same code twice; this is how it does not.
   */
  lastStep?: number
}

export interface FactorRecord {
  username: string
  /** The WebAuthn user handle, so a discoverable credential names an account. */
  userHandle: string
  passkeys: readonly StoredPasskey[]
  totp: TotpState | null
  /** Set by "not me": every sign-in is refused until the password changes. */
  mustChangePassword: boolean
}

interface Persisted {
  version: 2
  factors: FactorRecord[]
}

const empty = (username: string, userHandle: string): FactorRecord => ({
  username,
  userHandle,
  passkeys: [],
  totp: null,
  mustChangePassword: false
})

export class V2Factors {
  private readonly file: string
  private readonly now: () => number
  private records: readonly FactorRecord[] = []

  constructor(base: string, now: () => number = Date.now) {
    mkdirSync(base, { recursive: true })
    this.now = now
    this.file = path.join(base, FACTORS_FILE)
    if (existsSync(this.file)) this.load()
  }

  /**
   * A TORN FILE STOPS THE PROCESS, as it does for accounts. Starting with an
   * empty factor file would silently DEMOTE every account to password-only —
   * the ladder would let a stranger past with a password alone, and the
   * evidence would be overwritten by the first write.
   */
  private load(): void {
    const complain = (why: string): never => {
      throw new Error(
        `refusing to start: ${this.file} could not be read as a factor file (${why}). ` +
          'Nothing has been changed — restore it from a backup, or move it aside to start with no factors.'
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      complain(error instanceof Error ? error.message : 'it is not JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) complain('it is not an object')
    const held = parsed as Partial<Persisted>
    if (!Array.isArray(held.factors)) complain('it has no list of factors')
    for (const record of held.factors as FactorRecord[]) {
      if (typeof record?.username !== 'string' || !Array.isArray(record?.passkeys)) {
        complain('an entry in it has no username or no passkeys')
      }
    }
    this.records = held.factors as FactorRecord[]
  }

  private save(): void {
    const body: Persisted = { version: 2, factors: [...this.records] }
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(body), { mode: 0o600 })
      renameSync(temp, this.file)
    } catch (error) {
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        // A stranded temp file is not worth a throw; the rename is what matters.
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private write(record: FactorRecord): FactorRecord {
    this.records = this.records.some((r) => r.username === record.username)
      ? this.records.map((r) => (r.username === record.username ? record : r))
      : [...this.records, record]
    this.save()
    return record
  }

  // ── reading ────────────────────────────────────────────────────────────

  /** The record for an account, invented in memory but not written until it is. */
  get(username: string): FactorRecord {
    return this.records.find((r) => r.username === username) ?? empty(username, '')
  }

  passkeys(username: string): readonly StoredPasskey[] {
    return this.get(username).passkeys
  }

  hasPasskey(username: string): boolean {
    return this.get(username).passkeys.length > 0
  }

  totpActive(username: string): boolean {
    return this.get(username).totp?.active === true
  }

  /** The public shape of the Security section: never a secret, only a posture. */
  summary(username: string): {
    passkeys: { id: string; name: string; addedAt: number }[]
    totp: boolean
    mustChangePassword: boolean
  } {
    const record = this.get(username)
    return {
      passkeys: record.passkeys.map((p) => ({ id: p.id, name: p.name, addedAt: p.addedAt })),
      totp: record.totp?.active === true,
      mustChangePassword: record.mustChangePassword
    }
  }

  /** The handle a discoverable credential carries. Minted once, then kept. */
  userHandle(username: string): string {
    const record = this.get(username)
    if (record.userHandle !== '') return record.userHandle
    return this.write({ ...record, userHandle: randomBytes(16).toString('base64url') }).userHandle
  }

  usernameForHandle(handle: unknown): string | null {
    if (typeof handle !== 'string' || handle === '') return null
    return this.records.find((r) => r.userHandle === handle)?.username ?? null
  }

  /**
   * The account a credential id belongs to. A credential id is unique to the
   * authenticator that made it, so this is what makes the passwordless sheet
   * possible: the assertion says which key signed, and the key says who.
   */
  byCredentialId(credentialId: unknown): { username: string; passkey: StoredPasskey } | null {
    if (typeof credentialId !== 'string' || credentialId === '') return null
    for (const record of this.records) {
      const passkey = record.passkeys.find((p) => p.credentialId === credentialId)
      if (passkey) return { username: record.username, passkey }
    }
    return null
  }

  // ── passkeys ───────────────────────────────────────────────────────────

  addPasskey(
    username: string,
    input: { credentialId: string; jwk: Record<string, string>; name: unknown; signCount: number }
  ): { ok: true; passkey: StoredPasskey } | { ok: false; reason: 'too_many' | 'already_known' | 'bad_name' } {
    const record = this.get(username)
    if (record.passkeys.length >= PASSKEYS_MAX) return { ok: false, reason: 'too_many' }
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name.length === 0 || name.length > NAME_MAX) return { ok: false, reason: 'bad_name' }
    // A credential id already known ANYWHERE is not a new key: enrolling it
    // again on another account would make one authenticator answer for two.
    if (this.byCredentialId(input.credentialId) !== null) return { ok: false, reason: 'already_known' }
    const passkey: StoredPasskey = {
      id: randomUUID(),
      credentialId: input.credentialId,
      jwk: input.jwk,
      name,
      signCount: input.signCount,
      addedAt: this.now()
    }
    this.write({
      ...record,
      userHandle: record.userHandle === '' ? randomBytes(16).toString('base64url') : record.userHandle,
      passkeys: [...record.passkeys, passkey]
    })
    return { ok: true, passkey }
  }

  /**
   * REMOVING THE LAST PASSKEY IS ALLOWED. A passkey is a factor, not a device:
   * an account with none still has a password, and the ladder simply becomes
   * shorter. Refusing here would strand a person whose laptop is gone.
   */
  removePasskey(username: string, id: string): boolean {
    const record = this.get(username)
    if (!record.passkeys.some((p) => p.id === id)) return false
    this.write({ ...record, passkeys: record.passkeys.filter((p) => p.id !== id) })
    return true
  }

  /** The counter moves forward on every accepted assertion, and only forward. */
  noteSignCount(username: string, id: string, signCount: number): void {
    const record = this.get(username)
    if (!record.passkeys.some((p) => p.id === id)) return
    this.write({
      ...record,
      passkeys: record.passkeys.map((p) => (p.id === id ? { ...p, signCount } : p))
    })
  }

  // ── the authenticator ──────────────────────────────────────────────────

  /**
   * A secret, shown once, INACTIVE until a code proves the phone has it. An
   * account that is told it has an authenticator it never finished setting up
   * is an account whose ladder has a rung nobody can stand on.
   */
  beginTotp(username: string): { secret: string; otpauth: string } {
    const secret = mintTotpSecret()
    this.write({ ...this.get(username), totp: { secret, active: false, addedAt: this.now() } })
    return { secret, otpauth: otpauthUrl(username, secret) }
  }

  confirmTotp(username: string, code: unknown): boolean {
    const record = this.get(username)
    if (record.totp === null) return false
    const step = this.spendStep(record, code)
    if (step === null) return false
    this.write({ ...record, totp: { ...record.totp, active: true, lastStep: step } })
    return true
  }

  /** True when this code opens this account's authenticator right now — once. */
  checkTotp(username: string, code: unknown): boolean {
    const record = this.get(username)
    if (record.totp === null || !record.totp.active) return false
    const step = this.spendStep(record, code)
    if (step === null) return false
    this.write({ ...record, totp: { ...record.totp, lastStep: step } })
    return true
  }

  /** The step a code names, or null — refusing one already spent. */
  private spendStep(record: FactorRecord, code: unknown): number | null {
    if (record.totp === null) return null
    const step = totpStepFor(record.totp.secret, code, this.now())
    if (step === null) return null
    return step <= (record.totp.lastStep ?? -1) ? null : step
  }

  clearTotp(username: string): void {
    const record = this.get(username)
    if (record.totp === null) return
    this.write({ ...record, totp: null })
  }

  // ── "not me" ───────────────────────────────────────────────────────────

  mustChangePassword(username: string): boolean {
    return this.get(username).mustChangePassword
  }

  setMustChangePassword(username: string, value: boolean): void {
    const record = this.get(username)
    if (record.mustChangePassword === value) return
    this.write({ ...record, mustChangePassword: value })
  }
}
