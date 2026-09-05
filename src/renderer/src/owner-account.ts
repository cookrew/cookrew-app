import { useEffect, useState } from 'react'
import { cookrew } from './api'
import type { Availability } from './account-setup'

/**
 * THE OWNER'S ACCOUNT, as the renderer can see it.
 *
 * The three account channels are exposed by the PRELOAD only, and main refuses
 * any sender that is not the owner window's top frame — so a browser card, an
 * install page and the phone companion all find nothing here and the setup
 * sheet simply never renders for them. That is deliberate: minting a username
 * is permanent and first-mint-wins, and it belongs to the desktop (D1).
 *
 * Feature detection rather than a required member of CookrewApi, the same
 * shape the grant surface uses — it keeps remote-api.ts and demo-api.ts out of
 * a decision that is not theirs to make.
 */

export interface OwnerAccountStatus {
  handle: string | null
  registry: string
  /** The OS-derived suggestion for the field. Never an identity by itself. */
  suggestion: string
  /** `COOKREW_HANDLE`, when a developer set one. Shown, never adopted. */
  envHandle: string | null
}

export type MintResult =
  | { ok: true; handle: string }
  | { ok: false; reason: string; kind?: string }

export interface AccountBridge {
  status: () => Promise<OwnerAccountStatus>
  check: (handle: string) => Promise<Availability>
  mint: (handle: string) => Promise<MintResult>
}

interface RawBridge {
  accountStatus?: () => Promise<unknown>
  accountCheck?: (handle: string) => Promise<unknown>
  accountMint?: (handle: string) => Promise<unknown>
}

/** The bridge, or null on a transport that does not carry the owner's account. */
export function accountBridge(api: unknown = cookrew()): AccountBridge | null {
  const raw = api as RawBridge
  if (
    typeof raw.accountStatus !== 'function' ||
    typeof raw.accountCheck !== 'function' ||
    typeof raw.accountMint !== 'function'
  ) {
    return null
  }
  const { accountStatus, accountCheck, accountMint } = raw
  return {
    status: async () => asStatus(await accountStatus()),
    // An unreadable answer is `unknown`, never `free`: pressing Create on a
    // name nobody checked is the one mistake this field exists to prevent.
    check: async (handle) => asAvailability(await accountCheck(handle)),
    mint: async (handle) => asMintResult(await accountMint(handle))
  }
}

export function asStatus(value: unknown): OwnerAccountStatus {
  const body = (value ?? {}) as Partial<OwnerAccountStatus>
  return {
    handle: typeof body.handle === 'string' && body.handle.length > 0 ? body.handle : null,
    registry: typeof body.registry === 'string' ? body.registry : '',
    suggestion: typeof body.suggestion === 'string' ? body.suggestion : '',
    envHandle: typeof body.envHandle === 'string' && body.envHandle.length > 0 ? body.envHandle : null
  }
}

const AVAILABILITIES: readonly Availability[] = [
  'idle',
  'checking',
  'free',
  'taken',
  'invalid',
  'unknown'
]

export function asAvailability(value: unknown): Availability {
  const answer = (value as { availability?: unknown })?.availability
  return AVAILABILITIES.includes(answer as Availability) ? (answer as Availability) : 'unknown'
}

export function asMintResult(value: unknown): MintResult {
  const body = (value ?? {}) as Record<string, unknown>
  if (body.ok === true && typeof body.handle === 'string') {
    return { ok: true, handle: body.handle }
  }
  return {
    ok: false,
    reason:
      typeof body.reason === 'string' && body.reason.length > 0
        ? body.reason
        : 'the username could not be claimed — try again',
    ...(typeof body.kind === 'string' ? { kind: body.kind } : {})
  }
}

/**
 * The owner's account status, read once per mount.
 *
 * `undefined` while it is being read, so a caller can tell "not asked yet"
 * from "this transport has no account" (null) — rendering a first-run sheet
 * during the former would flash it at every owner on every launch.
 */
export function useOwnerAccount(): OwnerAccountStatus | null | undefined {
  const [status, setStatus] = useState<OwnerAccountStatus | null | undefined>(undefined)
  useEffect(() => {
    const bridge = accountBridge()
    if (bridge === null) {
      setStatus(null)
      return undefined
    }
    let live = true
    void bridge
      .status()
      .then((answer) => {
        if (live) setStatus(answer)
      })
      .catch(() => {
        if (live) setStatus(null)
      })
    return () => {
      live = false
    }
  }, [])
  return status
}
