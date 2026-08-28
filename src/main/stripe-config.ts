import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseEnvFile } from './service-grants'
import { stripeSecretMode, type StripeMode } from '../shared/served-payment-config'

export interface StripeSecretOptions {
  /** Defaults to the owner's Cookrew data directory. Tests inject a temp dir. */
  base?: string
  log?: (message: string) => void
}

/** The only path from which the main process accepts a Stripe secret. */
export function stripeEnvPath(base: string = path.join(homedir(), '.cookrew')): string {
  return path.join(base, 'stripe.env')
}

/**
 * Load the Stripe secret once at main-process boot.
 *
 * There is deliberately no process.env fallback. A broad inherited environment
 * is copied in several non-served spawn paths, while this file sits inside the
 * subtree Seatbelt denies to every served session. Keeping one source makes the
 * security claim inspectable instead of relying on every future spawn call.
 */
export function loadStripeSecret(options: StripeSecretOptions = {}): string | null {
  const file = stripeEnvPath(options.base)
  const log = options.log ?? console.error

  try {
    if ((statSync(file).mode & 0o777) !== 0o600) {
      log(`stripe: ignoring ${file} — chmod 600 it`)
      return null
    }
    const secret = parseEnvFile(readFileSync(file, 'utf8')).STRIPE_SECRET_KEY?.trim()
    if (!secret || stripeSecretMode(secret) === null) {
      if (secret) log(`stripe: ignoring invalid key in ${file}`)
      return null
    }
    return secret
  } catch (error) {
    // No file is the normal unconfigured state. Other failures are named by
    // path only; neither the file contents nor the thrown message are logged.
    if (existsSync(file)) log(`stripe: cannot read ${file}`)
    void error
    return null
  }
}

/**
 * Replace only STRIPE_SECRET_KEY and publish a 0600 file. The secret is never
 * returned or logged; callers receive its non-secret test/live mode only.
 */
export function writeStripeSecret(
  value: string,
  options: Pick<StripeSecretOptions, 'base'> = {}
): StripeMode {
  const secret = value.trim()
  const mode = stripeSecretMode(secret)
  if (mode === null) throw new Error('invalid Stripe secret key')

  const file = stripeEnvPath(options.base)
  let prior = ''
  try {
    prior = readFileSync(file, 'utf8')
  } catch {
    // A missing file is the ordinary first configuration.
  }

  const lines = prior.replace(/\r\n/g, '\n').split('\n')
  const next: string[] = []
  let replaced = false
  for (const line of lines) {
    if (/^\s*(?:export\s+)?STRIPE_SECRET_KEY\s*=/.test(line)) {
      if (!replaced) next.push(`STRIPE_SECRET_KEY=${secret}`)
      replaced = true
    } else if (line.length > 0 || next.length > 0) {
      next.push(line)
    }
  }
  if (!replaced) next.push(`STRIPE_SECRET_KEY=${secret}`)
  const body = `${next.join('\n').replace(/\n+$/g, '')}\n`

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
  writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temp, 0o600)
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  chmodSync(file, 0o600)
  return mode
}
