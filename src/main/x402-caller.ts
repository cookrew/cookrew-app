import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { PaymentRequirements } from './x402-rail'

/**
 * THE PAYER HALF of x402 — signing a transfer authorization for a quote.
 *
 * WHOSE KEY. Cookrew does not create wallets and does not hold keys. This
 * reads a wallet the OWNER of this machine provisioned themselves, at
 * ~/.cookrew/x402-caller.env (0600) — the same file the QA drivers use. If the
 * file is absent, this rail is simply not offered on this device, and the sheet
 * says so rather than inventing a wallet.
 *
 * WHAT IS SIGNED. EIP-712 `TransferWithAuthorization` over the quote's own
 * asset contract — an authorization the facilitator can submit, never a key or
 * a broadcast we perform. Every field is taken from the door's quote and
 * validated first: a malformed quote is refused rather than signed around,
 * because a signature over the wrong `to` or `value` is money gone.
 */

const CALLER_ENV = () => path.join(homedir(), '.cookrew', 'x402-caller.env')

/** Parse a KEY=value env file (export prefixes and quotes tolerated). */
function readEnvFile(file: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const sourceLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const name = line.slice(0, equals).trim()
    let value = line.slice(equals + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values.set(name, value)
  }
  return values
}

export class X402CallerError extends Error {}

/** The private key, refused unless the file is private to this user. */
function callerPrivateKey(): `0x${string}` {
  const file = CALLER_ENV()
  let mode: number
  try {
    mode = statSync(file).mode
  } catch {
    throw new X402CallerError('no wallet is set up on this device')
  }
  if ((mode & 0o077) !== 0) {
    throw new X402CallerError(`${file} must be private — run chmod 600 on it`)
  }
  const key = readEnvFile(file).get('X402_CALLER_PRIVATE_KEY')
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new X402CallerError(`${file} has no valid X402_CALLER_PRIVATE_KEY`)
  }
  return key as `0x${string}`
}

/**
 * The wallet this device can pay from, or null when none is provisioned.
 * Address only — the key never leaves this module, and never reaches the
 * renderer, which is why the sheet is handed a label rather than a wallet.
 */
export function deviceWallet(): { address: string } | null {
  try {
    return { address: privateKeyToAccount(callerPrivateKey()).address }
  } catch {
    return null
  }
}

function chainIdFor(network: string): number {
  if (network === 'base-sepolia') return 84532
  if (network === 'base') return 8453
  throw new X402CallerError(`no chain id is configured for the x402 network '${network}'`)
}

/**
 * Build the `X-PAYMENT` header for one quote. Throws rather than returning a
 * header the door will refuse: an unpayable quote is the door's problem to
 * fix, and a signature over a guess is the one failure that costs money.
 */
export async function buildX402Payment(requirements: PaymentRequirements): Promise<string> {
  if (
    requirements?.scheme !== 'exact' ||
    typeof requirements.network !== 'string' ||
    typeof requirements.maxAmountRequired !== 'string' ||
    !isAddress(requirements.payTo) ||
    !isAddress(requirements.asset) ||
    typeof requirements.maxTimeoutSeconds !== 'number' ||
    typeof requirements.extra?.name !== 'string' ||
    typeof requirements.extra?.version !== 'string'
  ) {
    throw new X402CallerError('this quote is malformed — nothing was signed')
  }
  let value: bigint
  try {
    value = BigInt(requirements.maxAmountRequired)
  } catch {
    throw new X402CallerError('this quote has an invalid amount — nothing was signed')
  }
  if (value <= 0n || !Number.isFinite(requirements.maxTimeoutSeconds) || requirements.maxTimeoutSeconds <= 0) {
    throw new X402CallerError('this quote has invalid payment bounds — nothing was signed')
  }

  const account = privateKeyToAccount(callerPrivateKey())
  const now = Math.floor(Date.now() / 1000)
  const authorization = {
    from: account.address,
    to: requirements.payTo as `0x${string}`,
    value,
    // A minute of slack absorbs clock skew between this machine and the chain.
    validAfter: BigInt(Math.max(0, now - 60)),
    validBefore: BigInt(now + Math.floor(requirements.maxTimeoutSeconds)),
    nonce: `0x${randomBytes(32).toString('hex')}` as `0x${string}`
  }
  const signature = await account.signTypedData({
    domain: {
      name: requirements.extra.name,
      version: requirements.extra.version,
      chainId: chainIdFor(requirements.network),
      verifyingContract: requirements.asset as `0x${string}`
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization
  })

  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: {
        signature,
        authorization: {
          ...authorization,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString()
        }
      }
    })
  ).toString('base64')
}
