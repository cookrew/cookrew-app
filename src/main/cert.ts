import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CERT_DIR = path.join(homedir(), '.cookrew', 'certs')
const KEY_FILE = path.join(CERT_DIR, 'key.pem')
const CERT_FILE = path.join(CERT_DIR, 'cert.pem')

export interface Cert {
  key: Buffer
  cert: Buffer
}

/**
 * Ensure a self-signed cert covering localhost + the given LAN IPs exists,
 * so the mobile server can serve HTTPS. Web Speech / getUserMedia require a
 * secure context; plain http://<lan-ip> is not one, but https:// is (even
 * with a self-signed cert the user accepts once). Returns null if openssl
 * is unavailable, letting the caller fall back to HTTP-only.
 */
export function ensureCert(ips: string[]): Cert | null {
  try {
    if (existsSync(KEY_FILE) && existsSync(CERT_FILE)) {
      return { key: readFileSync(KEY_FILE), cert: readFileSync(CERT_FILE) }
    }
    mkdirSync(CERT_DIR, { recursive: true })
    const sans = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',')
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', KEY_FILE,
        '-out', CERT_FILE,
        '-days', '3650',
        '-subj', '/CN=Cookrew Mobile',
        '-addext', `subjectAltName=${sans}`
      ],
      { stdio: 'ignore' }
    )
    return { key: readFileSync(KEY_FILE), cert: readFileSync(CERT_FILE) }
  } catch (error) {
    console.error('Self-signed cert generation failed (mobile HTTPS disabled):', error)
    return null
  }
}
