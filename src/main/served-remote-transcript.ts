import { createPrivateKey, sign, type JsonWebKey } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { callAssertionPayload } from './call-ceremony'
import {
  SERVED_TRANSCRIPT_PATHS,
  type ServedRemoteTurnSource,
  type ServedTracePage,
  type ServedTranscriptTarget,
  type ServedTurnsWireResponse
} from '../shared/served-transcript'
import type { TraceBoundaryMarker, TraceIndexEntry, TracePageRequest } from '../shared/trace-blocks'
import { pageTurns, type TurnPage, type TurnPageRequest, type TurnRecord } from '../shared/turn'

class CallerKeyPending extends Error {}

interface StoredCallerKey {
  pub: JsonWebKey
  priv: JsonWebKey
}

const emptyTurns = (): TurnPage => ({ turns: [], total: 0, offset: 0 })
const emptyTrace = (): ServedTracePage => ({ blocks: [], total: 0, source: null })

function targetBase(target: ServedTranscriptTarget): URL {
  const url = new URL(target.origin)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('served transcript origin is invalid')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('served transcript origin is invalid')
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.slug)) {
    throw new Error('served transcript slug is invalid')
  }
  return new URL(`/${target.slug}/`, url)
}

function keyFileFor(base: string, target: ServedTranscriptTarget): string {
  const host = targetBase(target).host.replace(/[^a-z0-9.-]/gi, '_')
  return path.join(base, 'crew-keys', `${host}-${target.slug}.json`)
}

function readCallerKey(base: string, target: ServedTranscriptTarget): StoredCallerKey {
  const file = keyFileFor(base, target)
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      throw new Error('served caller credential permissions are not private')
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') throw new Error('served caller credential is invalid')
    const key = parsed as Partial<StoredCallerKey>
    if (!key.pub || !key.priv) throw new Error('served caller credential is invalid')
    // Validate the private half now; no key material leaves this function.
    createPrivateKey({ key: key.priv, format: 'jwk' })
    return { pub: key.pub, priv: key.priv }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // crew-line owns first creation. Until it boots, the honest state is that
      // this caller has no transcript yet, not an invented empty session.
      throw new CallerKeyPending('served caller credential is still starting')
    }
    throw error
  }
}

function queryUrl(
  base: URL,
  pathname: string,
  query: object = {}
): URL {
  const url = new URL(pathname.replace(/^\//, ''), base)
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url
}

async function jsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

/**
 * Main-process adapter for one placed crew. The private key and Bearer remain
 * here; renderer IPC receives transcript data only.
 */
export class ServedRemoteTranscriptClient implements ServedRemoteTurnSource {
  private readonly base: URL
  private readonly keyBase: string
  private readonly fetcher: typeof fetch
  private token: string | null = null
  private signingIn: Promise<string> | null = null

  constructor(
    private readonly target: ServedTranscriptTarget,
    options: { keyBase?: string; fetcher?: typeof fetch } = {}
  ) {
    this.base = targetBase(target)
    this.keyBase = options.keyBase ?? path.join(homedir(), '.cookrew')
    this.fetcher = options.fetcher ?? fetch
  }

  private async signIn(): Promise<string> {
    const key = readCallerKey(this.keyBase, this.target)
    const faceResponse = await this.fetcher(queryUrl(this.base, '/crew'))
    const face = (await jsonBody(faceResponse)) as { serviceId?: unknown } | null
    if (!faceResponse.ok || typeof face?.serviceId !== 'string' || face.serviceId.length === 0) {
      throw new Error(`served transcript sign-in failed (HTTP ${faceResponse.status})`)
    }

    const challengeResponse = await this.fetcher(queryUrl(this.base, '/api/call/challenge'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    })
    const challengeBody = (await jsonBody(challengeResponse)) as { challenge?: unknown } | null
    if (
      !challengeResponse.ok ||
      typeof challengeBody?.challenge !== 'string' ||
      challengeBody.challenge.length === 0
    ) {
      throw new Error(`served transcript sign-in failed (HTTP ${challengeResponse.status})`)
    }

    const sub = userInfo().username || 'caller'
    const privateKey = createPrivateKey({ key: key.priv, format: 'jwk' })
    const signature = sign(
      null,
      Buffer.from(callAssertionPayload(face.serviceId, sub, challengeBody.challenge), 'utf8'),
      privateKey
    ).toString('base64url')
    const assertionResponse = await this.fetcher(queryUrl(this.base, '/api/call/assert'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sub,
        challenge: challengeBody.challenge,
        signature,
        jwk: key.pub
      })
    })
    const assertion = (await jsonBody(assertionResponse)) as { token?: unknown } | null
    if (!assertionResponse.ok || typeof assertion?.token !== 'string' || assertion.token.length === 0) {
      throw new Error(`served transcript sign-in failed (HTTP ${assertionResponse.status})`)
    }
    return assertion.token
  }

  private async bearer(): Promise<string> {
    if (this.token) return this.token
    if (!this.signingIn) {
      this.signingIn = this.signIn().finally(() => {
        this.signingIn = null
      })
    }
    this.token = await this.signingIn
    return this.token
  }

  private async get(
    pathname: string,
    query: object = {}
  ): Promise<{ status: number; body: unknown }> {
    const run = async (token: string): Promise<Response> =>
      this.fetcher(queryUrl(this.base, pathname, query), {
        headers: { authorization: `Bearer ${token}` }
      })
    let response = await run(await this.bearer())
    if (response.status === 401) {
      this.token = null
      response = await run(await this.bearer())
    }
    const body = await jsonBody(response)
    if (response.status !== 404 && !response.ok) {
      throw new Error(`served transcript request failed (HTTP ${response.status})`)
    }
    return { status: response.status, body }
  }

  async listTurns(request: TurnPageRequest = {}): Promise<TurnPage> {
    try {
      const response = await this.get(SERVED_TRANSCRIPT_PATHS.turns, request)
      if (response.status === 404) return emptyTurns()
      const wire = response.body as ServedTurnsWireResponse
      if (!Array.isArray(wire)) return wire
      const paged = Object.values(request).some((value) => value !== undefined)
      return paged
        ? pageTurns(wire, request)
        : { turns: wire, total: wire.length, offset: 0 }
    } catch (error) {
      if (error instanceof CallerKeyPending) return emptyTurns()
      throw error
    }
  }

  async listTrace(request: TracePageRequest = {}): Promise<ServedTracePage> {
    try {
      const response = await this.get(SERVED_TRANSCRIPT_PATHS.trace, request)
      return response.status === 404 ? emptyTrace() : (response.body as ServedTracePage)
    } catch (error) {
      if (error instanceof CallerKeyPending) return emptyTrace()
      throw error
    }
  }

  async listTraceIndex(request: { afterIndex?: number } = {}): Promise<TraceIndexEntry[]> {
    try {
      const response = await this.get(SERVED_TRANSCRIPT_PATHS.traceIndex, request)
      return response.status === 404 ? [] : (response.body as TraceIndexEntry[])
    } catch (error) {
      if (error instanceof CallerKeyPending) return []
      throw error
    }
  }

  async listTraceMarkers(): Promise<TraceBoundaryMarker[]> {
    try {
      const response = await this.get(SERVED_TRANSCRIPT_PATHS.traceMarkers)
      return response.status === 404 ? [] : (response.body as TraceBoundaryMarker[])
    } catch (error) {
      if (error instanceof CallerKeyPending) return []
      throw error
    }
  }
}
