import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { MAGPIE_KEY_ACK_PATH, MAGPIE_KEY_PATH, MAGPIE_KEY_RETURN_PATH, MAGPIE_REMOTE_KIND, SEALED_PLACEHOLDER_KEY, type MagpieKeyAckAnswer, type MagpieKeyAnswer } from '../../shared/remote-magpie'
import type { Fields } from '../../shared/seal2/frames'
import { readBody, requestFields } from '../../shared/seal2/http'
import type { Seal2Stream } from '../../shared/seal2/stream'
import { ABORT } from '../../shared/seal2/spec'
import type { DiscoveryEnv } from '../route/discovery'
import { providersFile } from '../route/remote-ports'
import type { ProviderEntry } from './remotes'

/**
 * THE TWO ENDS' SMALL TALK, AND THIS COMPUTER'S MAGPIE CLI (lane Magpie).
 *
 * Asking for a key and giving it back are one `magpie` stream each to the other
 * desktop (serve.ts). The provider this computer's Magpie gets is added with a
 * placeholder for a key (SEALED_PLACEHOLDER_KEY) and the forwarder's address:
 * nothing secret is ever on a `magpie` command line.
 */

type OpenStream = (peer: string, kind: string, fields: Fields) => Promise<Seal2Stream>

const KEY_RE = /^sk-magpie-[A-Za-z0-9_-]{16,256}$/

/**
 * How long one exchange may take, from opening its stream to the end of the answer (review M2). A key
 * request can wait behind B's Magpie CLI (several calls, each up to 30 s), so it is generous; past it the
 * stream is aborted and the exchange throws, as a broken stream does, and nothing holds the connect lane.
 */
export const EXCHANGE_DEADLINE_MS = 120_000

export interface ExchangeOptions {
  /** Tests shorten it; defaults to EXCHANGE_DEADLINE_MS. */
  readonly deadlineMs?: number
}

async function exchange(open: OpenStream, peer: string, path: string, body: unknown, headers: Readonly<Record<string, string>> = {}, options: ExchangeOptions = {}): Promise<{ status: number; json: unknown }> {
  let stream: Seal2Stream | null = null
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      stream?.abort(ABORT.cancel, 'no answer in time')
      reject(new Error('The other computer did not answer in time.'))
    }, options.deadlineMs ?? EXCHANGE_DEADLINE_MS)
  })
  const talk = async (): Promise<{ status: number; json: unknown }> => {
    const opened = await open(peer, MAGPIE_REMOTE_KIND, requestFields('POST', path, { ...headers, 'content-type': 'application/json' }))
    stream = opened
    // Opened after the deadline: nobody is waiting for it any more.
    if (expired) opened.abort(ABORT.cancel, 'no answer in time')
    const writer = opened.writable.getWriter()
    await writer.write(new TextEncoder().encode(JSON.stringify(body)))
    await writer.close()
    const head = await opened.head
    const text = new TextDecoder().decode(await readBody(opened.readable))
    try {
      return { status: head.status, json: JSON.parse(text) }
    } catch {
      return { status: head.status, json: null }
    }
  }
  try {
    return await Promise.race([talk(), deadline])
  } finally {
    clearTimeout(timer)
  }
}

export function askKeyOver(open: OpenStream, options: ExchangeOptions = {}): (peer: string, myName: string) => Promise<MagpieKeyAnswer> {
  return async (peer, myName) => {
    const { json } = await exchange(open, peer, MAGPIE_KEY_PATH, { name: myName }, {}, options)
    const a = json as { ok?: unknown; key?: unknown; id?: unknown; why?: unknown; error?: { message?: unknown } } | null
    if (a?.ok === true && typeof a.key === 'string' && KEY_RE.test(a.key) && typeof a.id === 'string') return { ok: true, key: a.key, id: a.id }
    const why = typeof a?.why === 'string' ? a.why : typeof a?.error?.message === 'string' ? a.error.message : 'The other computer did not give a key.'
    return { ok: false, why }
  }
}

/**
 * Say the key is stored (serve.ts · ackKey): the key rides as the credential header inside the seal, as on
 * every model request, and only its id in the body. Throws when the stream breaks: the caller may ask again,
 * acknowledgements being idempotent. A 404 is a Cookrew from before acknowledgements (`old`).
 */
export function ackKeyOver(open: OpenStream, options: ExchangeOptions = {}): (peer: string, key: string, id: string) => Promise<MagpieKeyAckAnswer> {
  return async (peer, key, id) => {
    const { status, json } = await exchange(open, peer, MAGPIE_KEY_ACK_PATH, { id }, { authorization: `Bearer ${key}` }, options)
    const a = json as { ok?: unknown; why?: unknown; error?: { message?: unknown } } | null
    if (status === 200 && a?.ok === true) return { ok: true }
    // "Not now" (B could not read its Magpie's keys): unheard, not refused. The key waits to be said again.
    // 403 is B switched off for now (serve.ts refuses every stream then): also unheard, not a refusal of the key.
    if (status === 503 || status === 403) throw new Error(typeof a?.why === 'string' ? a.why : 'The other computer could not check the key just now.')
    const why = typeof a?.why === 'string' ? a.why : typeof a?.error?.message === 'string' ? a.error.message : 'The other computer did not confirm the key.'
    return { ok: false, why, old: status === 404 }
  }
}

/** Give the key back; throws unless the other computer says it revoked every key it gave this one. */
export function returnKeyOver(open: OpenStream, options: ExchangeOptions = {}): (peer: string) => Promise<void> {
  return async (peer) => {
    const { status, json } = await exchange(open, peer, MAGPIE_KEY_RETURN_PATH, {}, {}, options)
    const a = json as { ok?: unknown; why?: unknown } | null
    if (status !== 200 || a?.ok !== true) throw new Error(typeof a?.why === 'string' ? a.why : 'The other computer did not take its key back.')
  }
}

function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 30_000 }, (error, _stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolve({ code, stderr: String(stderr) })
    })
  })
}

const lastLine = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^\d{4}\/\d{2}\/\d{2} /.test(l))
    .at(-1)
    ?.replace(/^magpie:\s*/, '')
    .slice(0, 200) ?? 'Magpie did not add the provider.'

const URL_FIELDS = ['url', 'anthropic', 'chat', 'responses', 'decide'] as const

/** Providers in this computer's Magpie: id, preset and endpoint addresses only (never a key); [] with no list yet, null unreadable. */
export function providerEntries(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): ProviderEntry[] | null {
  let text: string
  try {
    text = read(providersFile(d))
  } catch (error) {
    return (error as { code?: unknown })?.code === 'ENOENT' ? [] : null
  }
  try {
    const parsed = JSON.parse(text) as { providers?: unknown }
    if (parsed.providers === undefined) return []
    if (!Array.isArray(parsed.providers)) return null
    return parsed.providers.flatMap((raw) => {
      const p = raw as Record<string, unknown> | null
      if (typeof p?.id !== 'string') return []
      const urls = URL_FIELDS.flatMap((f) => (typeof p[f] === 'string' ? [p[f] as string] : []))
      return [{ id: p.id, preset: typeof p.preset === 'string' ? p.preset : null, urls }]
    })
  } catch {
    return null
  }
}

export function magpieProviders(bin: () => string | null, env: () => DiscoveryEnv): {
  add(providerId: string, url: string): Promise<{ ok: true } | { ok: false; why: string }>
  set(providerId: string, url: string): Promise<{ ok: true } | { ok: false; why: string }>
  remove(providerId: string): Promise<void>
  entries(): Promise<ProviderEntry[] | null>
} {
  const magpie = async (args: string[]): Promise<{ ok: true } | { ok: false; why: string }> => {
    const b = bin()
    if (b === null) return { ok: false, why: 'Magpie is not installed on this computer.' }
    const done = await run(b, args)
    return done.code === 0 ? { ok: true } : { ok: false, why: lastLine(done.stderr) }
  }
  return {
    add: (providerId, url) => magpie(['provider', 'add', 'remote-magpie', SEALED_PLACEHOLDER_KEY, `url=${url}`, `id=${providerId}`]),
    set: (providerId, url) => magpie(['provider', 'set', providerId, `url=${url}`]),
    remove: async (providerId) => {
      const b = bin()
      if (b !== null) await run(b, ['provider', 'rm', providerId])
    },
    entries: async () => providerEntries(env())
  }
}
