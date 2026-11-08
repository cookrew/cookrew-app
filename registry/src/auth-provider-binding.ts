import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ProviderId } from '../../src/shared/oauth'
import { DeviceTransactions, hashBrowserSecret, hashCsrfToken, type DeviceTransactionResult } from './auth-device-transaction'
import type { OAuthProvider, ProviderProof } from './v2-oauth-providers'

/** This in-process primitive does not create a session, attach a device, or resolve an account. */
interface Credentials { transactionId: unknown; browserSecret: unknown; csrfToken: unknown }
interface Options {
  transactions: DeviceTransactions
  providers: ReadonlyMap<ProviderId, OAuthProvider>
  callbackOrigin: string
  isDeviceRevoked: (deviceId: string) => boolean
  now?: () => number
}
interface Pending {
  device: DeviceTransactionResult
  browserHash: string
  csrfHash: string
  provider: ProviderId
  verifier: string
  nonce: string
  expiresAt: number
  proof?: ProviderProof
}
const STATE = /^[A-Za-z0-9_-]{43}$/
const secret = () => randomBytes(32).toString('base64url')
const digest = (value: string) => createHash('sha256').update(value).digest('base64url')
const equals = (a: string | null, b: string): boolean => {
  if (a === null || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export class ProviderBinding {
  private readonly pending = new Map<string, Pending>()
  private readonly states = new Map<string, string>()
  private readonly now: () => number
  private readonly origin: string
  constructor(private readonly options: Options) {
    const url = new URL(options.callbackOrigin)
    const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.origin !== options.callbackOrigin || (!loopback && url.origin !== 'https://cookrew.dev')) throw new Error('Invalid provider callback origin')
    this.origin = url.origin
    this.now = options.now ?? Date.now
  }
  private sweep(): void {
    for (const [id, item] of this.pending) if (this.now() >= item.expiresAt) this.remove(id)
  }
  private remove(id: string): void {
    this.pending.delete(id)
    for (const [state, owner] of this.states) if (owner === id) this.states.delete(state)
  }
  start(providerId: ProviderId, credentials: Credentials): { authorizeUrl: string; expiresAt: number } | null {
    this.sweep()
    const provider = this.options.providers.get(providerId)
    if (!provider || this.pending.size >= 1000) return null
    const browserHash = hashBrowserSecret(credentials.browserSecret)
    const csrfHash = hashCsrfToken(credentials.csrfToken)
    if (!browserHash || !csrfHash) return null
    const taken = this.options.transactions.takeForProvider(credentials)
    if (!taken.ok) return null
    const state = secret(), verifier = secret(), nonce = secret()
    const item: Pending = { device: taken.result, browserHash, csrfHash, provider: providerId, verifier, nonce, expiresAt: taken.expiresAt }
    const id = taken.result.transactionId
    try {
      const authorizeUrl = provider.authorizeUrl({ state, challenge: digest(verifier), nonce, redirectUri: `${this.origin}/v2/oauth/${providerId}/callback` })
      this.pending.set(id, item)
      this.states.set(digest(state), id)
      return { authorizeUrl, expiresAt: item.expiresAt }
    } catch { return null }
  }
  /**
   * Whether a callback names a state this binding minted and still holds.
   * Spends nothing, so a router can ask it before handing the callback to
   * whichever flow owns the state.
   */
  owns(params: URLSearchParams): boolean {
    this.sweep()
    const states = params.getAll('state')
    return states.length === 1 && STATE.test(states[0]) && this.states.has(digest(states[0]))
  }
  async callback(providerId: ProviderId, params: URLSearchParams): Promise<boolean> {
    this.sweep()
    const states = params.getAll('state')
    if (states.length !== 1 || !STATE.test(states[0])) return false
    const key = digest(states[0]), id = this.states.get(key)
    if (!id) return false
    this.states.delete(key)
    const item = this.pending.get(id), provider = this.options.providers.get(providerId)
    if (!item || !provider || item.provider !== providerId || params.has('error') || params.getAll('code').length !== 1) {
      this.remove(id); return false
    }
    const code = params.get('code')!
    if (!code || code.length > 4096) { this.remove(id); return false }
    try {
      const answer = await provider.exchange({ code, verifier: item.verifier, nonce: item.nonce, redirectUri: `${this.origin}/v2/oauth/${providerId}/callback` })
      if (!answer.ok || answer.proof.provider !== providerId || this.now() >= item.expiresAt || this.pending.get(id) !== item) {
        this.remove(id); return false
      }
      this.pending.set(id, { ...item, proof: Object.freeze({ ...answer.proof }) })
      return true
    } catch { this.remove(id); return false }
  }
  finish(credentials: Credentials): { device: DeviceTransactionResult; proof: ProviderProof } | null {
    this.sweep()
    if (typeof credentials.transactionId !== 'string') return null
    const item = this.pending.get(credentials.transactionId)
    if (!item?.proof || !equals(hashBrowserSecret(credentials.browserSecret), item.browserHash) || !equals(hashCsrfToken(credentials.csrfToken), item.csrfHash)) return null
    this.remove(credentials.transactionId)
    try {
      if (this.options.isDeviceRevoked(item.device.device.deviceId) !== false) return null
    } catch { return null }
    return Object.freeze({ device: item.device, proof: item.proof })
  }
}
