/**
 * AUTHORITATIVE DNS — ADDRESSES, AND WHY THIS PARSER IS SO NARROW.
 *
 * A/AAAA rdata is bytes, and the zone's gate compares an address in a NAME
 * against an address in a signed reach card. Both need one reader, and it has
 * to be the SAME one: a parser that accepts more shapes than the thing it
 * guards is a parser that disagrees with the gate, and the disagreement is
 * always in the attacker's favour.
 *
 * So: dotted-quad IPv4, and IPv6 as plain hextets with at most one `::`. No
 * IPv4-mapped tail, no zone id, no leading-zero octets — a reach card cannot
 * carry any of them (see v2-reach.ts), and neither can a label.
 */

export interface Ip {
  family: 4 | 6
  bytes: Uint8Array
}

const v4 = (text: string): Uint8Array | null => {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null
    const n = Number(parts[i])
    if (n > 255) return null
    out[i] = n
  }
  return out
}

const v6 = (text: string): Uint8Array | null => {
  const halves = text.split('::')
  if (halves.length > 2) return null
  const read = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const hextet of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null
      out.push(Number.parseInt(hextet, 16))
    }
    return out
  }
  const head = read(halves[0])
  const tail = halves.length === 2 ? read(halves[1]) : []
  if (head === null || tail === null) return null
  const gap = 8 - head.length - tail.length
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null
  const hextets = [...head, ...new Array<number>(halves.length === 2 ? gap : 0).fill(0), ...tail]
  const out = new Uint8Array(16)
  hextets.forEach((h, i) => {
    out[i * 2] = h >> 8
    out[i * 2 + 1] = h & 0xff
  })
  return out
}

/**
 * An address, or null. Deliberately narrow: dotted-quad IPv4 and plain IPv6
 * hextets with one `::`. No IPv4-mapped tail, no zone id — a desktop's reach
 * card cannot carry either, and a parser that accepts more shapes than the
 * thing it guards is a parser that disagrees with the gate.
 */
export function parseIp(text: unknown): Ip | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 45) return null
  const bare = text.replace(/^\[|\]$/g, '').toLowerCase()
  const four = v4(bare)
  if (four !== null) return { family: 4, bytes: four }
  if (!bare.includes(':')) return null
  const six = v6(bare)
  return six === null ? null : { family: 6, bytes: six }
}

/**
 * The address as text, uncompressed. Not RFC 5952 pretty — nothing here reads
 * it but `parseIp` on the way back into rdata, and a form with no `::` in it
 * has no ambiguity to get wrong.
 */
export function ipText(ip: Ip): string {
  if (ip.family === 4) return Array.from(ip.bytes).join('.')
  const hextets: string[] = []
  for (let i = 0; i < 16; i += 2) hextets.push((((ip.bytes[i] << 8) | ip.bytes[i + 1]) >>> 0).toString(16))
  return hextets.join(':')
}

/** Byte equality, so `::1` and `0:0:0:0:0:0:0:1` are the same address. */
export function sameIp(a: Ip, b: Ip): boolean {
  if (a.family !== b.family || a.bytes.length !== b.bytes.length) return false
  return a.bytes.every((byte, i) => byte === b.bytes[i])
}

