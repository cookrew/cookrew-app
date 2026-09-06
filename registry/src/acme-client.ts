import { b64url, accountKey, dns01Digest, externalAccountBinding, signJws, type AccountKey } from './acme-jose'

/**
 * ACME (RFC 8555) — THE PROTOCOL HALF.
 *
 * Directory, account, order, dns-01, finalize, chain. No dependencies: the
 * registry bundle has none and this is not the place to start.
 *
 * NOTHING HERE THROWS ACROSS THE ROUTE BOUNDARY. A CA that is down, slow,
 * angry or unparseable comes back as a typed refusal, because the caller is an
 * HTTP handler that owes somebody a status code either way. The one exception
 * is a programming error in our own signing, which is a bug and not a state.
 *
 * EVERY WAIT IS BOUNDED. Retry-After is honoured but capped, the poll count is
 * capped, each request has its own timeout, and the whole issuance has a
 * deadline. An ACME client that can wait forever is a route that can wait
 * forever.
 *
 * THE CHALLENGE IS PUBLISHED BY THE CALLER. This file never touches the DNS
 * zone; it hands the digest to `publish` and takes it back with `retract` in a
 * `finally`, so a failed order cannot leave a TXT record standing.
 */

/** Let's Encrypt STAGING. Production is always an explicit flag — see main.ts. */
export const LETSENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'
export const LETSENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'

export type AcmeReason = 'unreachable' | 'timeout' | 'server' | 'rejected' | 'malformed' | 'gave_up'
export interface AcmeRefusal {
  ok: false
  reason: AcmeReason
  /** One line, for an operator. Never a key and never a whole body. */
  detail: string
}
export type AcmeResult<T> = { ok: true; value: T } | AcmeRefusal

const refuse = (reason: AcmeReason, detail: string): AcmeRefusal => ({ ok: false, reason, detail })

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface AcmeOptions {
  directory: string
  /** Where the account key lives. The same volume as everything else. */
  dataDir: string
  /** mailto contact, when the deployment gave one. Optional per RFC 8555. */
  email?: string
  /** For a CA that requires one (ZeroSSL). Let's Encrypt does not. */
  eab?: { kid: string; hmacKey: string }
  fetch?: FetchLike
  /** Per-request budget. */
  timeoutMs?: number
  /** Whole-issuance budget. */
  deadlineMs?: number
  /** How long to wait between polls when the CA names no Retry-After. */
  pollMs?: number
  pollsMax?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Stage lines for an operator: "order", "valid". Never a body, never a key. */
  log?: (message: string) => void
}

export interface IssueRequest {
  /** The names to certify — `*.<deviceId>.<zone>` for a Mac. */
  identifiers: readonly string[]
  /** The Mac's own CSR, DER. Its private key never comes near this process. */
  csrDer: Uint8Array
  /** Put these digests at that TXT name. Called once per name. */
  publish: (host: string, digests: readonly string[]) => void | Promise<void>
  /** Take the name down again — called on every path out, success or not. */
  retract: (host: string) => void | Promise<void>
}

export interface Issued {
  /** The leaf and its issuers, PEM, in the order the CA sent them. */
  chain: string
}

interface Wire {
  status: number
  headers: Headers
  body: unknown
  text: string
}

const RETRY_AFTER_MAX_MS = 5000
const NONCE_RETRIES = 3

export class AcmeClient {
  private readonly fetcher: FetchLike
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private directory: Record<string, string> | null = null
  private nonce: string | null = null
  private kid: string | null = null
  private account: AccountKey | null = null

  constructor(private readonly options: AcmeOptions) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private note(message: string): void {
    this.options.log?.(`acme: ${message}`)
  }

  // ── transport ──────────────────────────────────────────────────────────

  private async http(url: string, init: RequestInit): Promise<AcmeResult<Wire>> {
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
      })
      const replay = response.headers.get('replay-nonce')
      if (replay !== null) this.nonce = replay
      const text = await response.text()
      const type = response.headers.get('content-type') ?? ''
      let body: unknown = text
      if (type.includes('json') && text !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          return refuse('malformed', `${url} answered unreadable JSON`)
        }
      }
      return { ok: true, value: { status: response.status, headers: response.headers, body, text } }
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') return refuse('timeout', `${url} did not answer in time`)
      return refuse('unreachable', `${url} could not be reached`)
    }
  }

  private async load(): Promise<AcmeResult<Record<string, string>>> {
    if (this.directory !== null) return { ok: true, value: this.directory }
    const out = await this.http(this.options.directory, { method: 'GET' })
    if (!out.ok) return out
    const body = out.value.body
    if (out.value.status !== 200 || typeof body !== 'object' || body === null) {
      return refuse('server', `the ACME directory answered ${out.value.status}`)
    }
    this.directory = body as Record<string, string>
    return { ok: true, value: this.directory }
  }

  private async freshNonce(): Promise<AcmeResult<string>> {
    if (this.nonce !== null) {
      const held = this.nonce
      this.nonce = null
      return { ok: true, value: held }
    }
    const dir = await this.load()
    if (!dir.ok) return dir
    const out = await this.http(dir.value.newNonce, { method: 'HEAD' })
    if (!out.ok) return out
    const nonce = this.nonce
    this.nonce = null
    return nonce === null ? refuse('server', 'the CA issued no nonce') : { ok: true, value: nonce }
  }

  /** A signed POST, retried once per stale nonce — the CA's own retry contract. */
  private async post(url: string, payload: unknown | null, withJwk = false): Promise<AcmeResult<Wire>> {
    if (this.account === null) return refuse('server', 'no account key loaded')
    for (let attempt = 0; attempt < NONCE_RETRIES; attempt += 1) {
      const nonce = await this.freshNonce()
      if (!nonce.ok) return nonce
      const header = withJwk
        ? { alg: 'ES256' as const, nonce: nonce.value, url, jwk: this.account.jwk }
        : { alg: 'ES256' as const, nonce: nonce.value, url, kid: this.kid ?? '' }
      const out = await this.http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json' },
        body: signJws(this.account.key, header, payload)
      })
      if (!out.ok) return out
      const problem = out.value.body as { type?: string; detail?: string } | null
      if (out.value.status === 400 && problem?.type === 'urn:ietf:params:acme:error:badNonce') continue
      if (out.value.status >= 400) {
        return refuse(
          out.value.status >= 500 ? 'server' : 'rejected',
          `${problem?.type ?? 'error'}: ${problem?.detail ?? `HTTP ${out.value.status}`}`
        )
      }
      return out
    }
    return refuse('server', 'the CA kept refusing our nonce')
  }

  // ── account ────────────────────────────────────────────────────────────

  /** The directory and a registered account. Idempotent; called by `issue`. */
  async ready(): Promise<AcmeResult<void>> {
    if (this.kid !== null) return { ok: true, value: undefined }
    const dir = await this.load()
    if (!dir.ok) return dir
    if (this.account === null) this.account = accountKey(this.options.dataDir)
    const payload: Record<string, unknown> = { termsOfServiceAgreed: true }
    if (this.options.email !== undefined) payload.contact = [`mailto:${this.options.email}`]
    if (this.options.eab !== undefined) {
      payload.externalAccountBinding = externalAccountBinding(
        this.options.eab,
        this.account.jwk,
        dir.value.newAccount
      )
    }
    // The SAME key always lands on the same account, whether it is being made
    // now or was made a year ago; the CA answers 201 or 200 and both are fine.
    const out = await this.post(dir.value.newAccount, payload, true)
    if (!out.ok) return out
    const location = out.value.headers.get('location')
    if (location === null) return refuse('malformed', 'the CA named no account URL')
    this.kid = location
    this.note('account ready')
    return { ok: true, value: undefined }
  }

  // ── polling ────────────────────────────────────────────────────────────

  private waitFor(headers: Headers): number {
    const asked = Number(headers.get('retry-after') ?? '')
    const ms = Number.isFinite(asked) && asked > 0 ? asked * 1000 : (this.options.pollMs ?? 500)
    return Math.min(ms, RETRY_AFTER_MAX_MS)
  }

  /** POST-as-GET a resource until it settles, or until the budget runs out. */
  private async poll(
    url: string,
    settled: (status: string) => boolean,
    deadline: number
  ): Promise<AcmeResult<Record<string, unknown>>> {
    const max = this.options.pollsMax ?? 30
    for (let attempt = 0; attempt < max; attempt += 1) {
      const out = await this.post(url, null)
      if (!out.ok) return out
      const body = out.value.body as Record<string, unknown> | null
      if (body === null || typeof body !== 'object') return refuse('malformed', `${url} answered no object`)
      const status = typeof body.status === 'string' ? body.status : ''
      if (settled(status)) return { ok: true, value: body }
      if (status === 'invalid' || status === 'revoked' || status === 'deactivated') {
        const problem = (body.error ?? {}) as { detail?: string }
        return refuse('rejected', `the CA marked it ${status}${problem.detail ? `: ${problem.detail}` : ''}`)
      }
      if (this.now() > deadline) return refuse('gave_up', `${url} was still ${status || 'pending'}`)
      await this.sleep(this.waitFor(out.value.headers))
    }
    return refuse('gave_up', `${url} never settled`)
  }

  // ── issuance ───────────────────────────────────────────────────────────

  async issue(request: IssueRequest): Promise<AcmeResult<Issued>> {
    const ready = await this.ready()
    if (!ready.ok) return ready
    const published = new Set<string>()
    try {
      return await this.order(request, published)
    } finally {
      // ON EVERY PATH OUT. A challenge record that outlives its order is a
      // name answering something no CA will ever ask about again.
      for (const host of published) {
        try {
          await request.retract(host)
        } catch {
          this.note('a challenge record could not be retracted')
        }
      }
    }
  }

  private async order(request: IssueRequest, published: Set<string>): Promise<AcmeResult<Issued>> {
    const deadline = this.now() + (this.options.deadlineMs ?? 60_000)
    const dir = this.directory
    if (dir === null || this.account === null) return refuse('server', 'the client is not ready')

    const created = await this.post(dir.newOrder, {
      identifiers: request.identifiers.map((value) => ({ type: 'dns', value }))
    })
    if (!created.ok) return created
    const orderUrl = created.value.headers.get('location')
    const order = created.value.body as { authorizations?: unknown; finalize?: unknown }
    if (orderUrl === null || !Array.isArray(order.authorizations) || typeof order.finalize !== 'string') {
      return refuse('malformed', 'the CA answered an order we could not read')
    }
    this.note(`order for ${request.identifiers.length} name(s)`)

    const challenges = await this.challenges(order.authorizations as string[])
    if (!challenges.ok) return challenges

    // One publish per NAME: a wildcard and its base share `_acme-challenge`,
    // and the CA reads both digests off the same record set.
    const byHost = new Map<string, string[]>()
    for (const one of challenges.value) {
      byHost.set(one.host, [...(byHost.get(one.host) ?? []), one.digest])
    }
    for (const [host, digests] of byHost) {
      await request.publish(host, digests)
      published.add(host)
    }

    for (const one of challenges.value) {
      const answered = await this.post(one.challengeUrl, {})
      if (!answered.ok) return answered
    }
    for (const one of challenges.value) {
      const valid = await this.poll(one.authzUrl, (status) => status === 'valid', deadline)
      if (!valid.ok) return valid
    }

    const ready = await this.poll(orderUrl, (status) => status === 'ready' || status === 'valid', deadline)
    if (!ready.ok) return ready
    if (ready.value.status === 'ready') {
      const finalized = await this.post(order.finalize, { csr: b64url(request.csrDer) })
      if (!finalized.ok) return finalized
    }
    const issued = await this.poll(orderUrl, (status) => status === 'valid', deadline)
    if (!issued.ok) return issued
    const certificate = issued.value.certificate
    if (typeof certificate !== 'string') return refuse('malformed', 'the CA named no certificate')

    const chain = await this.post(certificate, null)
    if (!chain.ok) return chain
    if (!chain.value.text.includes('BEGIN CERTIFICATE')) {
      return refuse('malformed', 'the CA answered something that is not a PEM chain')
    }
    this.note('chain downloaded')
    return { ok: true, value: { chain: chain.value.text } }
  }

  /** Each authorization's dns-01 challenge, as a name and a digest to publish. */
  private async challenges(
    urls: readonly string[]
  ): Promise<AcmeResult<{ authzUrl: string; challengeUrl: string; host: string; digest: string }[]>> {
    const out: { authzUrl: string; challengeUrl: string; host: string; digest: string }[] = []
    for (const url of urls) {
      const fetched = await this.post(url, null)
      if (!fetched.ok) return fetched
      const body = fetched.value.body as {
        status?: string
        identifier?: { value?: string }
        challenges?: { type?: string; url?: string; token?: string }[]
      }
      // Already valid from an earlier order: nothing to publish, nothing to answer.
      if (body.status === 'valid') continue
      const value = body.identifier?.value
      const challenge = (body.challenges ?? []).find((one) => one.type === 'dns-01')
      if (typeof value !== 'string' || challenge === undefined) {
        return refuse('rejected', 'the CA offered no dns-01 challenge for a name')
      }
      if (typeof challenge.url !== 'string' || typeof challenge.token !== 'string') {
        return refuse('malformed', 'the CA answered a challenge we could not read')
      }
      out.push({
        authzUrl: url,
        challengeUrl: challenge.url,
        // The authorization names the BASE name even for a wildcard order, so
        // this is `_acme-challenge.<id>.<zone>` either way, exactly as the CA
        // will ask for it.
        host: `_acme-challenge.${value}`,
        digest: dns01Digest(challenge.token, this.account?.thumbprint ?? '')
      })
    }
    return { ok: true, value: out }
  }
}
