import { X509Certificate, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { mintNameKey } from './csr-build'

/**
 * WHERE THE TRUSTED CERTIFICATE LIVES, AND WHAT MAKES ONE USABLE.
 *
 * Beside the self-signed pair (cert.ts · ~/.cookrew/certs) rather than inside
 * it: the two have different lifetimes and different failure modes. The
 * self-signed cert is reissued whenever an address appears and is never worth
 * keeping; this one costs a Let's Encrypt order — 50 a week under cookrew.dev
 * for every Mac there is — so losing it is expensive and reissuing it casually
 * is how a deployment runs out of certificates.
 *
 * THE KEY IS MINTED ONCE AND KEPT. A renewal re-uses it, so a Mac that renews
 * every 60 days for a year still has one key and one file to protect. 0600,
 * temp-and-rename, in a 0700 directory: the same treatment account.json gets,
 * for the same reason — a torn write is not a lost setting, it is a Mac that
 * can no longer serve the name it published.
 *
 * A CHAIN IS ONLY HELD IF IT IS THIS MAC'S. Three checks, and each one has a
 * way of going wrong that this file is the last place to catch:
 *
 *   IT MATCHES THE KEY. A chain for a key we no longer have is a handshake
 *   that fails after the phone has already committed to the name.
 *   IT COVERS THE NAME. A device id changes when the account is re-claimed;
 *   yesterday's wildcard is then a name mismatch nobody can wave away.
 *   IT HAS NOT EXPIRED. Read off the leaf, never off the registry's number —
 *   the leaf is the thing the browser will read.
 */

/** Beside cert.ts's self-signed pair, in its own directory. */
export const namesCertDir = (base?: string): string =>
  path.join(base ?? path.join(homedir(), '.cookrew'), 'certs', 'names')

export interface HeldCert {
  /** The private key, PEM. Never logged, never sent, never leaves this Mac. */
  readonly key: string
  /** Leaf first, issuers after — exactly what a TLS context wants. */
  readonly chain: string
  /** Epoch ms the leaf stops being valid, read off the leaf itself. */
  readonly notAfter: number
  /** The one name this certificate covers. */
  readonly wildcard: string
}

const write0600 = (file: string, text: string): void => {
  const temp = `${file}.tmp`
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temp, 0o600)
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  chmodSync(file, 0o600)
}

/** The leaf of a chain, or null when the text is not a certificate at all. */
const leafOf = (chain: string): X509Certificate | null => {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(chain)
  if (first === null) return null
  try {
    return new X509Certificate(first[0])
  } catch {
    return null
  }
}

/** dNSNames off a leaf's subjectAltName, which Node formats as `DNS:a, DNS:b`. */
const dnsNamesOf = (leaf: X509Certificate): string[] =>
  (leaf.subjectAltName ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^DNS:/i.test(entry))
    .map((entry) => entry.slice(4).toLowerCase())

export class NameCertStore {
  private readonly dir: string
  private readonly keyFile: string
  private readonly chainFile: string
  private cachedKey: KeyObject | null = null

  constructor(base?: string) {
    this.dir = namesCertDir(base)
    this.keyFile = path.join(this.dir, 'key.pem')
    this.chainFile = path.join(this.dir, 'chain.pem')
  }

  /**
   * This Mac's name key, minted on first use. Throws only if the disk refuses,
   * which the caller turns into "no certificate today" rather than a crash.
   */
  key(): KeyObject {
    if (this.cachedKey !== null) return this.cachedKey
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (existsSync(this.keyFile)) {
      try {
        this.cachedKey = createPrivateKey(readFileSync(this.keyFile, 'utf8'))
        return this.cachedKey
      } catch {
        // A key we cannot read is a key we cannot serve with. Replacing it
        // costs one order; keeping it costs every handshake.
        rmSync(this.keyFile, { force: true })
        rmSync(this.chainFile, { force: true })
      }
    }
    const minted = mintNameKey()
    write0600(this.keyFile, minted.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    this.cachedKey = minted.privateKey
    return this.cachedKey
  }

  /** The public half, for a certificate request. */
  publicKey(): KeyObject {
    return createPublicKey(this.key())
  }

  /**
   * The certificate this Mac may serve for `wildcard` right now, or null.
   *
   * `now` is passed rather than read so a test can stand at any point in the
   * life of a chain — and so the renewal decision and this one share a clock.
   */
  held(wildcard: string, now: number = Date.now()): HeldCert | null {
    if (!existsSync(this.chainFile) || !existsSync(this.keyFile)) return null
    try {
      const chain = readFileSync(this.chainFile, 'utf8')
      const leaf = leafOf(chain)
      if (leaf === null) return null
      if (!dnsNamesOf(leaf).includes(wildcard.toLowerCase())) return null
      const notAfter = Date.parse(leaf.validTo)
      if (!Number.isFinite(notAfter) || notAfter <= now) return null
      const key = this.key()
      if (!leaf.checkPrivateKey(key)) return null
      return {
        key: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
        chain,
        notAfter,
        wildcard: wildcard.toLowerCase()
      }
    } catch {
      // Anything unreadable is simply "nothing held": this Mac keeps serving
      // the self-signed certificate, which is where it started.
      return null
    }
  }

  /**
   * Take a chain from the registry, if it is one and if it is ours. Returns
   * what is now held, or null — the caller logs and tries again another day
   * rather than storing something it cannot serve.
   */
  save(chain: unknown, wildcard: string, now: number = Date.now()): HeldCert | null {
    if (typeof chain !== 'string' || chain.length === 0 || chain.length > 64 * 1024) return null
    const leaf = leafOf(chain)
    if (leaf === null) return null
    if (!dnsNamesOf(leaf).includes(wildcard.toLowerCase())) return null
    if (!leaf.checkPrivateKey(this.key())) return null
    const notAfter = Date.parse(leaf.validTo)
    if (!Number.isFinite(notAfter) || notAfter <= now) return null
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    write0600(this.chainFile, chain)
    return this.held(wildcard, now)
  }

  /** Drop the chain, keep the key: a fresh order re-uses the key by design. */
  forget(): void {
    rmSync(this.chainFile, { force: true })
  }
}
