import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { MAGPIE_KEY_PATH, MAGPIE_KEY_RETURN_PATH, MAGPIE_REMOTE_KIND, SEALED_PLACEHOLDER_KEY, type MagpieKeyAnswer } from '../../shared/remote-magpie'
import type { Fields } from '../../shared/seal2/frames'
import { readBody, requestFields } from '../../shared/seal2/http'
import type { Seal2Stream } from '../../shared/seal2/stream'
import type { DiscoveryEnv } from '../route/discovery'
import { providersFile } from '../route/remote-ports'

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

async function exchange(open: OpenStream, peer: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const stream = await open(peer, MAGPIE_REMOTE_KIND, requestFields('POST', path, { 'content-type': 'application/json' }))
  const writer = stream.writable.getWriter()
  await writer.write(new TextEncoder().encode(JSON.stringify(body)))
  await writer.close()
  const head = await stream.head
  const text = new TextDecoder().decode(await readBody(stream.readable))
  try {
    return { status: head.status, json: JSON.parse(text) }
  } catch {
    return { status: head.status, json: null }
  }
}

export function askKeyOver(open: OpenStream): (peer: string, myName: string) => Promise<MagpieKeyAnswer> {
  return async (peer, myName) => {
    const { json } = await exchange(open, peer, MAGPIE_KEY_PATH, { name: myName })
    const a = json as { ok?: unknown; key?: unknown; id?: unknown; why?: unknown; error?: { message?: unknown } } | null
    if (a?.ok === true && typeof a.key === 'string' && KEY_RE.test(a.key) && typeof a.id === 'string') return { ok: true, key: a.key, id: a.id }
    const why = typeof a?.why === 'string' ? a.why : typeof a?.error?.message === 'string' ? a.error.message : 'The other computer did not give a key.'
    return { ok: false, why }
  }
}

export function returnKeyOver(open: OpenStream): (peer: string) => Promise<void> {
  return async (peer) => {
    await exchange(open, peer, MAGPIE_KEY_RETURN_PATH, {})
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

/** Provider ids in this computer's Magpie (ids only); [] when there is no list yet, null when it cannot be read. */
export function providerIds(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): string[] | null {
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
    return parsed.providers.flatMap((p) => (typeof (p as { id?: unknown })?.id === 'string' ? [(p as { id: string }).id] : []))
  } catch {
    return null
  }
}

export function magpieProviders(bin: () => string | null, env: () => DiscoveryEnv): {
  add(providerId: string, url: string): Promise<{ ok: true } | { ok: false; why: string }>
  set(providerId: string, url: string): Promise<{ ok: true } | { ok: false; why: string }>
  remove(providerId: string): Promise<void>
  ids(): Promise<string[] | null>
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
    ids: async () => providerIds(env())
  }
}
