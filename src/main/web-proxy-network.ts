import { blockedHost } from '../shared/web-proxy'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Agent } from 'undici'

/**
 * What the proxy may dial: everything except this machine itself, its link-local
 * neighbours, cloud metadata, and the address forms that are never a site.
 *
 * PRIVATE NETWORKS ARE ALLOWED ON PURPOSE (owner, 2026-11-23). The card's session
 * lives on a computer the person owns, and using that computer's network is the
 * point: a NAS, a router's page, a dev server, a Tailscale host, and the local
 * proxy this machine's own traffic already passes through. The fence that
 * matters is this computer's loopback, where Cookrew's own services answer, plus
 * link-local and metadata addresses — those stay shut.
 */
/**
 * The fence: this machine itself, its link-local neighbours, metadata, and the
 * address forms that are never a site. Private networks are NOT here — the proxy
 * exists to use the owner's own network (see below).
 */
function neverDial(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (/^(?:127\.|0\.)/.test(host)) return true
  if (/^169\.254\.169\.254$/.test(host)) return true
  if (/^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(host)) return true
  if (host === '::1' || /^fe[89ab][0-9a-f]:/.test(host) || /^fec0::/i.test(host)) return true
  if (/^2001:db8:/i.test(host)) return true
  if (/^fd00:ec2::254$/i.test(host) || host === 'metadata.google.internal') return true
  if (/^ff[0-9a-f]{2}:/i.test(host)) return true
  return false
}

export function publicProxyAddress(address: string): boolean {
  if (neverDial(address)) return false
  if (isIP(address) === 6) {
    const [first, second = ''] = address.toLowerCase().split(':')
    // Global unicast, and the unique-local range (fc00::/7) a home network uses.
    const uniqueLocal = /^f[cd][0-9a-f]{2}$/.test(first)
    return uniqueLocal || (/^[23][0-9a-f]{3}$/.test(first) &&
      !(first === '2001' && Number.parseInt(second || '0', 16) <= 0x1ff) &&
      second !== 'db8' && first !== '2002' && first !== '3fff')
  }
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  // Loopback, 0/8, link-local, multicast and the documentation ranges only.
  return a > 0 && a < 224 && a !== 127 &&
    !(a === 169 && b === 254) && !(a === 192 && (b === 0 || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 51 && c === 100)) &&
    !(a === 203 && b === 0 && c === 113)
}

function canonicalAddress(address: string): string {
  return isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname : address
}

function dialable(address: string): boolean {
  if (!publicProxyAddress(address)) return false
  const canonical = canonicalAddress(address)
  return !Object.values(networkInterfaces()).flat().some((entry) =>
    entry !== undefined && canonical === canonicalAddress(entry.address))
}

export function publicProxyHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '')
  return !url.username && !url.password && !blockedHost(host) &&
    (isIP(host) ? dialable(host) : host.includes('.'))
}

export class BlockedProxyTarget extends Error {}

// This lookup supplies the very addresses the socket uses. Looking up a host
// separately from fetch would leave a second DNS answer free to change them.
const dispatcher = new Agent({ connect: {
  lookup(hostname, options, callback) {
    lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      if (addresses.length === 0 || addresses.some(({ address }) => !dialable(address))) {
        return callback(new BlockedProxyTarget('This address is not allowed for this card.'), '', 0)
      }
      if (options.all) return callback(null, addresses)
      const [{ address, family }] = addresses
      callback(null, address, family)
    })
  }
} })

export const publicProxyFetch: typeof fetch = (url, options) => {
  const init = { ...options, dispatcher }
  return fetch(url, init)
}
