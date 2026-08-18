import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isTailnetAddress, isTailnetHost, type CertHosts } from './tailscale'

const DEFAULT_CERT_DIR = path.join(homedir(), '.cookrew', 'certs')

export interface Cert {
  key: Buffer
  cert: Buffer
}

/**
 * Host names out of an X509 subjectAltName string, which Node formats as
 * `DNS:localhost, IP Address:127.0.0.1`.
 */
export function sansOf(subjectAltName: string | undefined): string[] {
  if (!subjectAltName) return []
  return subjectAltName
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => entry.replace(/^(DNS|IP Address|IP|URI|email):/i, ''))
    .filter((entry) => entry.length > 0)
}

/**
 * One spelling for a host, so two sources can be compared.
 *
 * OpenSSL prints IPv6 SANs expanded and uppercase (FD7A:115C:A1E0:0:0:0:…)
 * while the OS and Tailscale report them compressed and lowercase
 * (fd7a:115c:a1e0::…). A plain string compare calls those different, which
 * makes ensureCert reissue the certificate on every single launch — and every
 * paired phone then has to accept a new self-signed cert each restart.
 *
 * The WHATWG URL parser canonicalises IPv6 to the compressed lowercase form,
 * which is exactly the normalisation needed and costs no dependency.
 */
export function canonicalHost(host: string): string {
  if (!host.includes(':')) return host.toLowerCase()
  try {
    return new URL(`http://[${host}]`).hostname.replace(/^\[|]$/g, '')
  } catch {
    return host.toLowerCase()
  }
}

/** Hosts the caller needs that this cert does not cover. */
export function missingHosts(sans: string[], hosts: CertHosts): string[] {
  const covered = new Set(sans.map(canonicalHost))
  return [...hosts.ips, ...hosts.dnsNames].filter((host) => !covered.has(canonicalHost(host)))
}

/**
 * The hosts a reissued cert must carry: everything asked for, PLUS every
 * tailnet identity the outgoing cert already had.
 *
 * WHY RETENTION EXISTS — this is the cellular bug.
 * -----------------------------------------------
 * Tailscale is a launch agent; it is routinely still Stopped when Cookrew
 * starts, and it can be stopped for a whole session (a conflicting TUN proxy
 * will do it). While it is down `readTailnet()` answers null, so the requested
 * host set is LAN-only. That alone was harmless — until anything else made the
 * cert regenerate: joining a different Wi-Fi, a VM bringing up a bridge. The
 * reissue then wrote a cert with NO tailnet SAN, and the tailnet URL — the one
 * address that works off the LAN — became reachable and unloadable at the same
 * time. Wi-Fi kept working because the LAN address was in the fresh cert.
 *
 * So a regeneration may ADD hosts and may DROP a LAN address, but it can never
 * drop a tailnet one. The retained set is bounded by construction: a machine
 * has one tailnet identity (v4, v6, MagicDNS name), not a growing list.
 */
export function certPlan(existingSans: string[], hosts: CertHosts): CertHosts {
  const requested = new Set([...hosts.ips, ...hosts.dnsNames].map(canonicalHost))
  const retained = existingSans
    .map(canonicalHost)
    .filter((host) => isTailnetHost(host) && !requested.has(host))
  return {
    ips: [...hosts.ips, ...retained.filter(isTailnetAddress)],
    dnsNames: [...hosts.dnsNames, ...retained.filter((host) => !isTailnetAddress(host))]
  }
}

/** SAN entries for openssl, deduplicated by canonical spelling. */
function sanArguments(hosts: CertHosts): string[] {
  const seen = new Set<string>(['localhost', '127.0.0.1'])
  const entries = ['DNS:localhost', 'IP:127.0.0.1']
  const add = (host: string, prefix: 'IP' | 'DNS'): void => {
    const key = canonicalHost(host)
    if (key.length === 0 || seen.has(key)) return
    seen.add(key)
    entries.push(`${prefix}:${key}`)
  }
  for (const ip of hosts.ips) add(ip, 'IP')
  for (const name of hosts.dnsNames) add(name, 'DNS')
  return entries
}

/**
 * Ensure a self-signed cert covering localhost plus every given host exists,
 * so the mobile server can serve HTTPS. Web Speech / getUserMedia require a
 * secure context; plain http://<address> is not one, but https:// is (even
 * with a self-signed cert the user accepts once). Returns null if openssl is
 * unavailable, letting the caller fall back to HTTP-only.
 *
 * REGENERATES when the host set grows. The previous version returned any
 * existing cert unconditionally, so a machine that gained an address after
 * the cert was written — the ordinary Tailscale case — served a cert whose
 * SAN list did not include it. That address is then reachable and unloadable
 * at the same time, which reads to the user as "Tailscale doesn't work".
 */
export function ensureCert(hosts: CertHosts, certDir: string = DEFAULT_CERT_DIR): Cert | null {
  const keyFile = path.join(certDir, 'key.pem')
  const certFile = path.join(certDir, 'cert.pem')
  try {
    // Plan first, so the tailnet identity of the OUTGOING cert is part of what
    // the incoming one must cover — and part of what "already covered" means.
    let plan = hosts
    if (existsSync(keyFile) && existsSync(certFile)) {
      const existing = { key: readFileSync(keyFile), cert: readFileSync(certFile) }
      const existingSans = sansOf(new X509Certificate(existing.cert).subjectAltName)
      plan = certPlan(existingSans, hosts)
      const missing = missingHosts(existingSans, plan)
      if (missing.length === 0) return existing
      console.error(`Mobile cert missing ${missing.join(', ')} — regenerating`)
    }
    mkdirSync(certDir, { recursive: true })
    const sans = sanArguments(plan).join(',')
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile,
        '-out', certFile,
        '-days', '3650',
        '-subj', '/CN=Cookrew Mobile',
        '-addext', `subjectAltName=${sans}`
      ],
      { stdio: 'ignore' }
    )
    return { key: readFileSync(keyFile), cert: readFileSync(certFile) }
  } catch (error) {
    console.error('Self-signed cert generation failed (mobile HTTPS disabled):', error)
    return null
  }
}
