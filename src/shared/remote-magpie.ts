/**
 * ANOTHER COMPUTER'S MAGPIE AS ONE PROVIDER OF THIS ONE'S.
 *
 * Magpie has the provider built in (`remote-magpie`, 0.1.3935): its models and
 * routing groups arrive here as `<id>/…`, each request sent on in the API the
 * agent spoke. Cards keep talking to this computer's own Magpie on loopback, so
 * the route's loopback pin (main/route/discovery.ts) stays exactly as it is.
 *
 * The person types an address and a name; Cookrew types ONE line into the Setup
 * terminal, ending at `key=`, and the person pastes the key there and presses
 * Enter. The key never passes through a Cookrew field, bridge or file, the same
 * rule as every other key line (route-lines.ts).
 *
 * Plain http is allowed only where the key does not cross an open network: a
 * private address, a tailnet (WireGuard underneath) or a .local/.lan name. A bare
 * one-word name is not trusted: a search domain can resolve it to a public host,
 * and `ai` is a TLD of its own. Anything else must be https.
 */

export const REMOTE_MAGPIE_PRESET = 'remote-magpie'
export const MAGPIE_PORT = 3425

export type RemoteField = 'address' | 'name'

export type RemoteCheck =
  | { readonly ok: true; readonly url: string; readonly id: string; readonly line: string }
  | { readonly ok: false; readonly field: RemoteField; readonly why: string }

/** Provider ids a person would read as a vendor, not as a computer. */
const RESERVED = new Set(['anthropic', 'claude', 'codex', 'copilot', 'deepseek', 'gemini', 'google', 'group', 'lmstudio', 'magpie', 'ollama', 'openai', 'opencode', 'pi', 'remote-magpie'])
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const ID_MAX = 24
const LAN_SUFFIXES = ['.local', '.lan', '.home.arpa', '.ts.net']

const refuse = (field: RemoteField, why: string): RemoteCheck => ({ ok: false, field, why })

function ipv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const octets = parts.map(Number)
  return octets.every((o) => o <= 255) ? octets : null
}

function loopback(host: string): boolean {
  const ip = ipv4(host)
  return host === 'localhost' || host.endsWith('.localhost') || (ip !== null && (ip[0] === 127 || ip.every((o) => o === 0)))
}

/** A network the key may cross in plain http: private ranges, a tailnet, a LAN name. */
export function privateHost(host: string): boolean {
  const ip = ipv4(host)
  if (ip !== null) {
    const [a, b] = ip
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const name = host.toLowerCase()
  return LAN_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** The provider id the models will wear: `office/claude-…`. */
export function providerIdOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX)
    .replace(/-+$/, '')
  return slug === '' ? 'remote' : slug
}

export function remoteMagpieLine(url: string, id: string): string {
  return `magpie provider add ${REMOTE_MAGPIE_PRESET} url=${url} id=${id} key=`
}

function parseAddress(raw: string): { url: URL; typedScheme: boolean } | null {
  const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  try {
    return { url: new URL(typedScheme ? raw : `http://${raw}`), typedScheme }
  } catch {
    return null
  }
}

function checkAddress(input: unknown): { ok: true; url: string } | { ok: false; why: string } {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') return { ok: false, why: 'Type the other computer’s address, as its Magpie shows it.' }
  if (/\s/.test(raw)) return { ok: false, why: 'The address cannot hold a space.' }
  const parsed = parseAddress(raw)
  if (parsed === null) return { ok: false, why: 'That is not an address.' }
  const { url, typedScheme } = parsed
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, why: 'Use an http:// or https:// address.' }
  if (url.username || url.password) return { ok: false, why: 'Put the key in the terminal, not in the address.' }
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) return { ok: false, why: 'The address cannot hold a ? or a #.' }
  if (url.pathname !== '/' && url.pathname !== '') return { ok: false, why: 'Give the address alone, with no path after it.' }
  if (url.hostname.startsWith('[')) return { ok: false, why: 'Use the computer’s name or its IPv4 address.' }
  if (!HOST_RE.test(url.hostname)) return { ok: false, why: 'That is not an address.' }
  if (loopback(url.hostname)) return { ok: false, why: 'That is this computer. Type the address of the other one.' }
  const lan = privateHost(url.hostname)
  const scheme = typedScheme ? url.protocol : lan ? 'http:' : 'https:'
  if (scheme === 'http:' && !lan) return { ok: false, why: 'Use https here, or the private address or full .ts.net name of a computer on your own network: plain http would carry your key unprotected.' }
  // `new URL` drops a scheme's default port, so a typed :80 is read off what was typed.
  const typedPort = /:(\d{1,5})\/?$/.exec(raw)?.[1] ?? ''
  const port = typedScheme ? url.port : typedPort || String(MAGPIE_PORT)
  return { ok: true, url: `${scheme}//${url.hostname.toLowerCase()}${port ? `:${port}` : ''}` }
}

/** The form, checked: it arrives over a bridge, so every field is doubted. Nothing here touches the network. */
export function checkRemoteMagpie(input: unknown): RemoteCheck {
  const form = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const address = checkAddress(form.address)
  if (!address.ok) return refuse('address', address.why)
  const id = providerIdOf(typeof form.name === 'string' ? form.name : '')
  if (RESERVED.has(id)) return refuse('name', `“${id}” already names a vendor. Name the computer instead, such as “office”.`)
  return { ok: true, url: address.url, id, line: remoteMagpieLine(address.url, id) }
}
