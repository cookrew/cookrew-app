/**
 * A DOOR'S WALLET TERMS, READ ONCE.
 *
 * An x402 quote arrives from a door — somebody else's app, which the caller
 * has no reason to trust — and two things are made from it: the words on the
 * pay step ("1 USDC on base-sepolia") and a signature that moves money. If
 * those two are made by different readers, the door picks the difference:
 * `maxAmountRequired: "0x3B9ACA00"` was "0 USDC" to a label that wanted plain
 * digits and a thousand dollars to a signer that asked BigInt.
 *
 * So there is ONE reader, here, pure, in `shared` because main labels and
 * signs and the renderer keys what it displayed. It returns NUMBERS, not
 * strings to be read again, and it is strict about every field a signature
 * covers: an amount in plain decimal digits, addresses that are addresses, a
 * network this app can name a chain for, a validity with a ceiling, and a
 * token that is USDC — by contract address, because the label says USDC and
 * any EIP-3009 token would sign just as happily.
 *
 * A quote this will not read is not offered and is never signed.
 */

/** The networks this app pays on, and USDC's own contract on each. */
export const X402_NETWORKS = {
  'base-sepolia': { chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  base: { chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }
} as const

export type X402Network = keyof typeof X402_NETWORKS

/** USDC's decimals — the contract's, not a guess. */
export const USDC_DECIMALS = 6

/** The longest a signed authorization may stay valid. A door quotes five minutes. */
export const X402_MAX_VALIDITY_SECONDS = 60 * 60

/** What a quote says, in the types a signature is made from. */
export interface X402Terms {
  network: X402Network
  chainId: number
  /** Atomic units of USDC. */
  amount: bigint
  payTo: `0x${string}`
  asset: `0x${string}`
  maxTimeoutSeconds: number
  /** The asset's EIP-712 domain, as the door states it. */
  name: string
  version: string
}

/** Plain decimal digits, no sign, no leading zero, no more than thirty of them. */
const AMOUNT = /^[1-9]\d{0,29}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** Printable ASCII, one to thirty-two characters: a token's name, not a payload. */
const DOMAIN_TEXT = /^[\x20-\x7E]{1,32}$/

const isAddress = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && ADDRESS.test(value)

/** Read a quote, or refuse it whole. Never a partial reading, never a default. */
export function parseX402Terms(raw: unknown): X402Terms | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const quote = raw as Record<string, unknown>
  if (quote.scheme !== 'exact') return null

  const network = quote.network
  if (typeof network !== 'string' || !Object.prototype.hasOwnProperty.call(X402_NETWORKS, network)) return null
  const known = X402_NETWORKS[network as X402Network]

  const amount = quote.maxAmountRequired
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) return null

  if (!isAddress(quote.payTo) || !isAddress(quote.asset)) return null
  // THE TOKEN IS PINNED. The sheet says USDC and counts six decimals.
  if (quote.asset.toLowerCase() !== known.usdc.toLowerCase()) return null

  const validity = quote.maxTimeoutSeconds
  if (
    typeof validity !== 'number' ||
    !Number.isInteger(validity) ||
    validity < 1 ||
    validity > X402_MAX_VALIDITY_SECONDS
  ) {
    return null
  }

  const extra = quote.extra
  if (typeof extra !== 'object' || extra === null) return null
  const { name, version } = extra as Record<string, unknown>
  if (typeof name !== 'string' || !DOMAIN_TEXT.test(name)) return null
  if (typeof version !== 'string' || !DOMAIN_TEXT.test(version)) return null

  return {
    network: network as X402Network,
    chainId: known.chainId,
    // Safe: the pattern above admits nothing BigInt would read differently.
    amount: BigInt(amount),
    payTo: quote.payTo,
    asset: quote.asset,
    maxTimeoutSeconds: validity,
    name,
    version
  }
}

/** Atomic units, as plain digits, to decimal USDC. No float touches it. */
function decimalOf(atomic: string): string {
  const digits = atomic.padStart(USDC_DECIMALS + 1, '0')
  const whole = digits.slice(0, digits.length - USDC_DECIMALS)
  const fraction = digits.slice(digits.length - USDC_DECIMALS).replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole
}

/** The amount as the sheet prints it: decimal USDC, from the same bigint that is signed. */
export function x402TermsPrice(terms: X402Terms): string {
  return decimalOf(terms.amount.toString())
}

/**
 * EVERY SIGNED FIELD, as one comparable line.
 *
 * Two quotes with the same key ask a wallet for the same signature; anything
 * a door may reword without changing what is paid (a description, a resource)
 * is not in it. Addresses are lower-cased — a checksummed address and its
 * plain spelling are one account. This is what main remembers of the terms a
 * pay step showed, what the surface sends back with the PAY press, and what
 * the fresh quote at the press must equal.
 */
const KEY_VERSION = 'x402-terms/1'

/**
 * The two things a key says that a pay step PRINTS: the amount, as the same
 * decimal `x402TermsPrice` gives, and the network. Null for anything that is
 * not a key this module wrote.
 */
export function x402KeySays(key: unknown): { price: string; network: string } | null {
  if (typeof key !== 'string') return null
  const parts = key.split('|')
  if (parts.length !== 9 || parts[0] !== KEY_VERSION || !AMOUNT.test(parts[3])) return null
  return { price: decimalOf(parts[3]), network: parts[1] }
}

export function x402TermsKey(terms: X402Terms): string {
  return [
    KEY_VERSION,
    terms.network,
    String(terms.chainId),
    terms.amount.toString(),
    terms.payTo.toLowerCase(),
    terms.asset.toLowerCase(),
    String(terms.maxTimeoutSeconds),
    terms.name,
    terms.version
  ].join('|')
}
