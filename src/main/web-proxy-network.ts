import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Agent } from 'undici'
import { blockedHost } from '../shared/web-proxy'

/** The proxy may dial public unicast only, including after DNS resolution. */
export function publicProxyAddress(address: string): boolean {
  if (blockedHost(address)) return false
  if (isIP(address) === 6) {
    const [first, second = ''] = address.toLowerCase().split(':')
    return /^[23][0-9a-f]{3}$/.test(first) &&
      !(first === '2001' && (Number.parseInt(second || '0', 16) <= 0x1ff || second === 'db8')) &&
      first !== '2002' && first !== '3fff'
  }
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return a < 224 && a !== 0 && a !== 127 &&
    !(a === 169 && b === 254) && !(a === 192 && (b === 0 || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
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
