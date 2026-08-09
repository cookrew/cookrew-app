import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CertHosts } from './tailscale'

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
    if (existsSync(keyFile) && existsSync(certFile)) {
      const existing = { key: readFileSync(keyFile), cert: readFileSync(certFile) }
      const missing = missingHosts(sansOf(new X509Certificate(existing.cert).subjectAltName), hosts)
      if (missing.length === 0) return existing
      console.error(`Mobile cert missing ${missing.join(', ')} — regenerating`)
    }
    mkdirSync(certDir, { recursive: true })
    const sans = [
      'DNS:localhost',
      'IP:127.0.0.1',
      ...hosts.ips.map((ip) => `IP:${ip}`),
      ...hosts.dnsNames.map((name) => `DNS:${name}`)
    ].join(',')
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
