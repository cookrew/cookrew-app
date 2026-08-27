import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { combinePaymentTerms, type PaymentTermsEnvelope } from './payment-rails'
import { loadStripeSecret, stripeEnvPath, writeStripeSecret } from './stripe-config'
import { stripePaymentTerms, type StripeConfig } from './stripe-rail'
import { writeFileAtomic } from './turn-annotations'
import { BASE_SEPOLIA, paymentRequirements, type X402Config } from './x402-rail'
import {
  isPayToAddress,
  readyPaymentRails,
  stripeSecretMode,
  type PaymentConfigResult,
  type ServedPaymentStatus
} from '../shared/served-payment-config'
import { servedPaymentRails } from '../shared/served-payment-rails'

export interface PaymentTemplate {
  priceUsd?: string
  slug: string
}

export interface ServedPaymentConfig {
  x402Config(): X402Config
  stripeConfig(): StripeConfig | null
  terms(template: PaymentTemplate): PaymentTermsEnvelope | null
  status(): ServedPaymentStatus
  rails(): ReturnType<typeof readyPaymentRails>
  setPayTo(value: string): PaymentConfigResult
  setStripeSecret(value: string): PaymentConfigResult
}

export interface ServedPaymentConfigOptions {
  base: string
  env?: NodeJS.ProcessEnv
}

export function paymentConfigPath(base: string): string {
  return path.join(base, 'payment.json')
}

function loadPersistedPayTo(base: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paymentConfigPath(base), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return ''
    const payTo = (parsed as { payTo?: unknown }).payTo
    return typeof payTo === 'string' && isPayToAddress(payTo) ? payTo.trim() : ''
  } catch {
    return ''
  }
}

function savePayTo(base: string, payTo: string): void {
  mkdirSync(base, { recursive: true, mode: 0o700 })
  writeFileAtomic(paymentConfigPath(base), JSON.stringify({ payTo }, null, 2))
}

export function createServedPaymentConfig(
  options: ServedPaymentConfigOptions
): ServedPaymentConfig {
  const env = options.env ?? process.env

  const x402Config = (): X402Config => {
    const overridden = env.COOKREW_PAY_TO
    const payTo =
      overridden !== undefined
        ? isPayToAddress(overridden)
          ? overridden.trim()
          : ''
        : loadPersistedPayTo(options.base)
    return {
      ...BASE_SEPOLIA,
      payTo,
      facilitator: env.COOKREW_X402_FACILITATOR ?? BASE_SEPOLIA.facilitator,
      network: env.COOKREW_X402_NETWORK ?? BASE_SEPOLIA.network,
      asset: env.COOKREW_X402_ASSET ?? BASE_SEPOLIA.asset
    }
  }

  const stripeSnapshot = (): { config: StripeConfig | null; mode: 'test' | 'live' | null } => {
    const secret = loadStripeSecret({ base: options.base })
    const mode = secret === null ? null : stripeSecretMode(secret)
    return {
      config: secret === null || mode === null ? null : { secretKey: secret },
      mode
    }
  }

  const termsWith = (
    x402: X402Config,
    stripe: StripeConfig | null,
    template: PaymentTemplate
  ): PaymentTermsEnvelope | null =>
    combinePaymentTerms(
      paymentRequirements(
        x402,
        template.priceUsd ?? '',
        `/${template.slug}/ask`,
        `One session with the ${template.slug} crew`
      ),
      stripePaymentTerms(
        stripe,
        template.priceUsd ?? '',
        `/${template.slug}/api/call/pay`
      )
    )

  const terms = (template: PaymentTemplate): PaymentTermsEnvelope | null => {
    const stripe = stripeSnapshot()
    return termsWith(x402Config(), stripe.config, template)
  }

  const status = (): ServedPaymentStatus => {
    const x402 = x402Config()
    const stripe = stripeSnapshot()
    const rails = servedPaymentRails(
      termsWith(x402, stripe.config, { priceUsd: '1', slug: 'payment-preview' })
    )
    return {
      x402: rails.includes('x402')
        ? { ready: true, payTo: x402.payTo }
        : { ready: false },
      stripe:
        rails.includes('stripe') && stripe.mode !== null
          ? { ready: true, mode: stripe.mode }
          : { ready: false }
    }
  }

  return {
    x402Config,
    stripeConfig: () => stripeSnapshot().config,
    terms,
    status,
    rails: () => readyPaymentRails(status()),
    setPayTo(value): PaymentConfigResult {
      const payTo = value.trim()
      if (!isPayToAddress(payTo)) return { ok: false, reason: 'invalid-pay-to' }
      try {
        savePayTo(options.base, payTo)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'write-failed' }
      }
    },
    setStripeSecret(value): PaymentConfigResult {
      if (stripeSecretMode(value) === null) {
        return { ok: false, reason: 'invalid-stripe-key' }
      }
      try {
        writeStripeSecret(value, { base: options.base })
        return { ok: true }
      } catch {
        return { ok: false, reason: 'write-failed' }
      }
    }
  }
}

export { stripeEnvPath }
