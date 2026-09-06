/**
 * REACH v2.1 — THE NAME A TRUSTED CERTIFICATE COVERS.
 *
 * Every Mac with an account gets one wildcard certificate for
 * `*.<deviceId>.<zone>`, and each address it publishes is spelled as a label
 * under it: `192-168-2-40.<id>.d.cookrew.dev`. A phone loading that name gets
 * a real CA's certificate instead of "Proceed (unsafe)", and the registry's
 * own authoritative DNS answers the address — but only while this Mac is
 * publishing it.
 *
 * WHY THE RULES ARE COPIED RATHER THAN SHARED. The registry decides what a
 * name resolves to (registry/src/dns-zone.ts · `addressFromLabel`,
 * `labelForAddress`, and registry/src/dns-address.ts · `parseIp`); this Mac
 * decides what to PRINT and what to ask a certificate for. Two processes, two
 * repositories, one mapping — so the rules are restated here verbatim and
 * pinned by tests that mirror the registry's own cases (tests/reach-names.
 * test.ts against registry tests/registry-dns-zone.test.ts). A disagreement
 * between the two halves is a printed URL that does not resolve, which is the
 * worst kind: it looks like the product is broken rather than the name.
 *
 * THE MAPPING, in one sentence each:
 *   IPv4  dots become dashes            192.168.2.40      → 192-168-2-40
 *   IPv6  colons become dashes, and `::` becomes `--`, which is the one
 *         sequence a hextet can never contain, so it needs no escaping
 *                                       fd7a:115c:a1e0::1234 → fd7a-115c-a1e0--1234
 *
 * The address parser is deliberately NARROW — dotted-quad IPv4 and plain IPv6
 * hextets with at most one `::`, no IPv4-mapped tail and no zone id — because
 * the registry's gate is exactly that narrow, and a parser that accepts more
 * shapes than the thing it guards is a parser that disagrees with the gate.
 */

/** The subzone the registry is authoritative for. One flag, both halves. */
export const DEFAULT_NAME_ZONE = 'd.cookrew.dev'

type Ip = { readonly family: 4 | 6; readonly bytes: readonly number[] }

const v4 = (text: string): number[] | null => {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

const hextets = (part: string): number[] | null => {
  if (part === '') return []
  const out: number[] = []
  for (const hextet of part.split(':')) {
    if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null
    out.push(Number.parseInt(hextet, 16))
  }
  return out
}

const v6 = (text: string): number[] | null => {
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = hextets(halves[0])
  const tail = halves.length === 2 ? hextets(halves[1]) : []
  if (head === null || tail === null) return null
  const gap = 8 - head.length - tail.length
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null
  const filled = [...head, ...new Array<number>(halves.length === 2 ? gap : 0).fill(0), ...tail]
  const bytes: number[] = []
  for (const h of filled) bytes.push(h >> 8, h & 0xff)
  return bytes
}

/** An address, or null. Mirrors registry/src/dns-address.ts · parseIp. */
export function parseAddress(text: unknown): Ip | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 45) return null
  const bare = text.replace(/^\[|\]$/g, '').toLowerCase()
  const four = v4(bare)
  if (four !== null) return { family: 4, bytes: four }
  if (!bare.includes(':')) return null
  const six = v6(bare)
  return six === null ? null : { family: 6, bytes: six }
}

/**
 * The address as text, uncompressed — the same spelling the registry's
 * `ipText` produces, so a round trip through a label is comparable by string.
 */
export function addressText(ip: Ip): string {
  if (ip.family === 4) return ip.bytes.join('.')
  const parts: string[] = []
  for (let i = 0; i < 16; i += 2) parts.push((((ip.bytes[i] << 8) | ip.bytes[i + 1]) >>> 0).toString(16))
  return parts.join(':')
}

const IPV4_LABEL = /^\d{1,3}(?:-\d{1,3}){3}$/
const IPV6_LABEL = /^[0-9a-f-]{1,45}$/

/** A label back into an address, or null. Mirrors dns-zone.addressFromLabel. */
export function addressFromLabel(label: string): string | null {
  if (IPV4_LABEL.test(label)) {
    const ip = parseAddress(label.replace(/-/g, '.'))
    return ip === null ? null : addressText(ip)
  }
  if (!IPV6_LABEL.test(label)) return null
  const halves = label.split('--')
  if (halves.length > 2) return null
  const ip = parseAddress(halves.map((half) => half.replace(/-/g, ':')).join('::'))
  return ip === null ? null : addressText(ip)
}

/** The same mapping forwards, for whoever has to print the name. */
export function labelForAddress(address: string): string | null {
  const ip = parseAddress(address)
  if (ip === null) return null
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase()
  return ip.family === 4 ? bare.replace(/\./g, '-') : bare.replace(/::/g, '--').replace(/:/g, '-')
}

/** A device id may be a label and nothing more — the registry's own shape. */
const DEVICE_LABEL = /^[a-z0-9][a-z0-9-]{7,62}$/

/** The one name a Mac's certificate may cover. The CSR gate asks for exactly this. */
export function wildcardFor(deviceId: string, zone = DEFAULT_NAME_ZONE): string | null {
  const id = deviceId.toLowerCase()
  if (!DEVICE_LABEL.test(id)) return null
  return `*.${id}.${zone.toLowerCase().replace(/\.$/, '')}`
}

/** `192-168-2-40.<id>.<zone>`, or null when the address cannot be a label. */
export function trustedName(
  address: string,
  deviceId: string,
  zone = DEFAULT_NAME_ZONE
): string | null {
  const label = labelForAddress(address)
  const id = deviceId.toLowerCase()
  if (label === null || !DEVICE_LABEL.test(id)) return null
  return `${label}.${id}.${zone.toLowerCase().replace(/\.$/, '')}`
}

/**
 * THE MAPPING BACKWARDS, FROM A WHOLE HOSTNAME.
 *
 * `192-168-2-40.<id>.<zone>` -> `192.168.2.40`. Whoever holds a hostname and
 * has to say what PATH it is (the path badge) cannot read the label alone —
 * `192-168-2-40` on its own is a label anybody could serve — so the shape is
 * checked too: an address label, then a device id, then a zone of at least two
 * labels. The zone itself is deliberately NOT pinned, because a self-hosted
 * registry certifies names under its own.
 */
export function addressFromTrustedName(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.')
  // `<address>.<id>.<zone>`, and the shortest zone anyone delegates is two.
  if (labels.length < 4) return null
  if (!DEVICE_LABEL.test(labels[1])) return null
  return addressFromLabel(labels[0])
}

/**
 * `https://192-168-2-40.<id>.<zone>:8643` — an ORIGIN, never a URL with a
 * token on it. The reach card carries origins and the CORS allow-list compares
 * origins; a `?token=` here would be the pairing credential travelling on a
 * route that is not the pairing URL.
 */
export function trustedOrigin(
  address: string,
  deviceId: string,
  zone = DEFAULT_NAME_ZONE,
  port = 443
): string | null {
  const name = trustedName(address, deviceId, zone)
  if (name === null) return null
  return port === 443 ? `https://${name}` : `https://${name}:${port}`
}

/** Is this the wildcard's own name — exactly one label under `<id>.<zone>`? */
export function coveredByWildcard(
  servername: string,
  deviceId: string,
  zone = DEFAULT_NAME_ZONE
): boolean {
  const id = deviceId.toLowerCase()
  if (!DEVICE_LABEL.test(id)) return false
  const suffix = `.${id}.${zone.toLowerCase().replace(/\.$/, '')}`
  const asked = servername.toLowerCase().replace(/\.$/, '')
  if (!asked.endsWith(suffix)) return false
  const label = asked.slice(0, asked.length - suffix.length)
  // A wildcard covers ONE label. `a.b.<id>.<zone>` is not covered by
  // `*.<id>.<zone>` — RFC 6125 — and answering it with this certificate would
  // be a name mismatch the phone cannot wave away.
  return label.length > 0 && !label.includes('.')
}
