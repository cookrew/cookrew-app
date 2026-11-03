import { execFileSync } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
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
 * will do it). While it is down `readTailnetAsync()` answers null, so the requested
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
 * THIS MAC'S OWN CERTIFICATE AUTHORITY — the way onto the LAN that no
 * resolver and no proxy can take away.
 *
 * The trusted names under d.cookrew.dev carry a public certificate, and on
 * the owner's phone they never connect on the home Wi-Fi: a proxy app routes
 * them by domain to a node abroad, or a resolver hands back something that is
 * not 192.168.2.40, while the bare address opens at once (2026-10-16). A bare
 * address has no public certificate and never will. So the Mac signs its own:
 * a root that stays the same for ten years, kept beside the serving key, and
 * a short-lived serving certificate it issues for its addresses. (The profile
 * that let a phone trust the root was retired 2026-10-18: the companion now
 * reaches the Mac over WebRTC, which needs no certificate a phone must trust.)
 *
 * Why two certificates and not one self-signed one: iOS refuses a TLS server
 * certificate valid for more than 825 days or without serverAuth, whoever
 * trusts it (Apple HT210176). The root may be long-lived; what the server
 * presents may not. And the root must survive a reissue — a new address must
 * never cost the phone a second trust step.
 */
export const LOCAL_CA_FILE = 'ca.pem'
const LOCAL_CA_KEY_FILE = 'ca-key.pem'
/** Under Apple's 825 days and under the public 398, so no client has a reason to refuse it. */
export const LEAF_DAYS = 397
/** A serving certificate this close to its end is replaced at the next check. */
export const LEAF_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000

/** One openssl config line value: no newline, no section bracket. */
const configValue = (value: string): string => value.replace(/[\r\n[\]=]/g, ' ').trim()

const caName = (): string => `Cookrew Local CA (${configValue(hostname()).slice(0, 40) || 'this Mac'})`

/** The root, made once. Its key never leaves this directory and is 0600. */
function ensureLocalCa(certDir: string): X509Certificate {
  const caFile = path.join(certDir, LOCAL_CA_FILE)
  const caKeyFile = path.join(certDir, LOCAL_CA_KEY_FILE)
  if (existsSync(caFile) && existsSync(caKeyFile)) return new X509Certificate(readFileSync(caFile))
  const config = path.join(certDir, 'ca.cnf')
  writeFileSync(
    config,
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = v3',
      '[dn]',
      'O = Cookrew',
      `CN = ${caName()}`,
      '[v3]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier = hash',
      ''
    ].join('\n')
  )
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
        '-config', config, '-keyout', caKeyFile, '-out', caFile],
      { stdio: 'ignore' }
    )
  } finally {
    rmSync(config, { force: true })
  }
  chmodSync(caKeyFile, 0o600)
  return new X509Certificate(readFileSync(caFile))
}

/** The root's PEM, or null before the first serving certificate was made. */
export function localCaPem(certDir: string = DEFAULT_CERT_DIR): Buffer | null {
  try {
    return readFileSync(path.join(certDir, LOCAL_CA_FILE))
  } catch {
    return null
  }
}

/** Was this serving certificate signed by THIS root? A self-signed one from before was not. */
export function issuedByLocalCa(leaf: X509Certificate, ca: X509Certificate): boolean {
  try {
    return leaf.fingerprint256 !== ca.fingerprint256 && leaf.checkIssued(ca) && leaf.verify(ca.publicKey)
  } catch {
    return false
  }
}

/** Why the serving certificate on disk must be replaced, or null when it may stay. */
export function leafReplacement(
  leaf: X509Certificate,
  ca: X509Certificate,
  missing: readonly string[],
  now: number = Date.now()
): string | null {
  if (missing.length > 0) return `missing ${missing.join(', ')}`
  if (!issuedByLocalCa(leaf, ca)) return "not issued by this Mac's local CA"
  if (new Date(leaf.validTo).getTime() - now < LEAF_RENEW_BEFORE_MS) return 'about to expire'
  return null
}

/** Issue the serving certificate: key.pem, and cert.pem as the chain (serving cert, then root). */
function issueLeaf(certDir: string, plan: CertHosts): void {
  const keyFile = path.join(certDir, 'key.pem')
  const certFile = path.join(certDir, 'cert.pem')
  const stamp = `${process.pid}.${Date.now()}`
  const config = path.join(certDir, `leaf.${stamp}.cnf`)
  const ext = path.join(certDir, `leaf.${stamp}.ext`)
  const csr = path.join(certDir, `leaf.${stamp}.csr`)
  const keyTmp = path.join(certDir, `key.${stamp}.tmp`)
  const leafTmp = path.join(certDir, `leaf.${stamp}.pem`)
  writeFileSync(config, ['[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', 'O = Cookrew', 'CN = Cookrew Mobile', ''].join('\n'))
  writeFileSync(
    ext,
    [
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid,issuer',
      `subjectAltName = ${sanArguments(plan).join(',')}`,
      ''
    ].join('\n')
  )
  try {
    execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', config, '-keyout', keyTmp, '-out', csr], { stdio: 'ignore' })
    execFileSync(
      'openssl',
      ['x509', '-req', '-sha256', '-in', csr,
        '-CA', path.join(certDir, LOCAL_CA_FILE), '-CAkey', path.join(certDir, LOCAL_CA_KEY_FILE),
        '-set_serial', BigInt(`0x${randomBytes(15).toString('hex')}`).toString(),
        '-days', String(LEAF_DAYS), '-extfile', ext, '-out', leafTmp],
      { stdio: 'ignore' }
    )
    chmodSync(keyTmp, 0o600)
    writeFileSync(leafTmp, Buffer.concat([readFileSync(leafTmp), readFileSync(path.join(certDir, LOCAL_CA_FILE))]))
    renameSync(keyTmp, keyFile)
    renameSync(leafTmp, certFile)
  } finally {
    for (const file of [config, ext, csr, keyTmp, leafTmp]) rmSync(file, { force: true })
  }
}

/**
 * Ensure a serving certificate covering localhost plus every given host
 * exists, signed by this Mac's own root (above), so the mobile server can
 * serve HTTPS. Web Speech / getUserMedia require a secure context; plain
 * http://<address> is not one, but https:// is. Returns null if openssl is
 * unavailable, letting the caller fall back to HTTP-only.
 *
 * REGENERATES when the host set grows, when the certificate on disk was not
 * issued by this Mac's root (every self-signed one from before the root
 * existed), and when it is within a month of expiring. The root itself is
 * never replaced here: a phone that trusted it keeps trusting every reissue.
 */
export function ensureCert(hosts: CertHosts, certDir: string = DEFAULT_CERT_DIR): Cert | null {
  const keyFile = path.join(certDir, 'key.pem')
  const certFile = path.join(certDir, 'cert.pem')
  try {
    mkdirSync(certDir, { recursive: true })
    const ca = ensureLocalCa(certDir)
    // Plan first, so the tailnet identity of the OUTGOING cert is part of what
    // the incoming one must cover — and part of what "already covered" means.
    let plan = hosts
    if (existsSync(keyFile) && existsSync(certFile)) {
      const existing = { key: readFileSync(keyFile), cert: readFileSync(certFile) }
      const leaf = new X509Certificate(existing.cert)
      const existingSans = sansOf(leaf.subjectAltName)
      plan = certPlan(existingSans, hosts)
      const why = leafReplacement(leaf, ca, missingHosts(existingSans, plan))
      if (why === null) return existing
      console.error(`Mobile cert ${why} — reissuing`)
    }
    issueLeaf(certDir, plan)
    return { key: readFileSync(keyFile), cert: readFileSync(certFile) }
  } catch (error) {
    console.error('Mobile cert generation failed (mobile HTTPS disabled):', error)
    return null
  }
}
