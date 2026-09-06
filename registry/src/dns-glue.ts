import { parseIp } from './dns-address'
import type { NameServer } from './dns-zone'

/**
 * `--dns-ns ns1.d.cookrew.dev=1.2.3.4,ns2.d.cookrew.dev=5.6.7.8`, READ ONCE.
 *
 * It lives apart from main.ts because main.ts binds ports the moment it is
 * imported, and a value that decides what a public zone tells the world about
 * its own name servers deserves a test rather than a careful reading.
 *
 * A GLUE RECORD THAT IS NOT AN ADDRESS IS A ZONE THAT CANNOT BE FOUND. These
 * are the exact values typed by hand once into the parent zone at the
 * registrar; a typo in ours — `1.2.3.4.` , `ns1.example.com`, an empty string —
 * used to be accepted here and then answered as A rdata that would not encode,
 * so `ns1.d.cookrew.dev A` came back empty and the delegation was broken in a
 * way nothing said out loud. It refuses at boot instead: a registry that would
 * serve the wrong glue must not start, because the failure it produces is
 * intermittent and looks like somebody else's resolver.
 */
export function readNameServers(spec: string): NameServer[] | null {
  if (spec === '') return null
  const out: NameServer[] = []
  for (const entry of spec.split(',')) {
    const [host, address] = entry.split('=')
    if (!host || !address || !host.includes('.')) return null
    const trimmed = address.trim()
    // The SAME reader the zone uses to answer with it, so what boots and what
    // is served cannot disagree — no leading zeros, no zone id, no brackets
    // around something that is not an address.
    if (parseIp(trimmed) === null) return null
    out.push({ host: host.trim().toLowerCase(), address: trimmed })
  }
  return out.length === 0 ? null : out
}
