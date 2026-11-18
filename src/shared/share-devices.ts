/**
 * What the Routing panel's "Share with my devices" section and main say to
 * each other (main/route/share-keys.ts). The key travels exactly once, in the
 * answer to an issue, so the owner can copy it to the other device.
 */

export interface SharedKey {
  readonly id: string
  readonly name: string
  /** The device the key was made for. */
  readonly device: string
  /** Magpie's own words for the cap and what it used, such as "$1.25/$20.00 per day". */
  readonly limit: string | null
}

export type ShareIssueAnswer = { readonly ok: true; readonly key: string; readonly shared: SharedKey } | { readonly ok: false; readonly why: string }

export type ShareRevokeAnswer = { readonly ok: true } | { readonly ok: false; readonly why: string }

export interface ShareWhere {
  /** Magpie listens beyond this computer: another device can reach it at all. */
  readonly onNetwork: boolean
  /** This computer's LAN and tailnet addresses with the gateway's port. */
  readonly urls: readonly string[]
}

export type ShareListAnswer = { readonly ok: true; readonly keys: readonly SharedKey[]; readonly where: ShareWhere } | { readonly ok: false; readonly why: string }

/** Issuance stays unavailable until crash-safe key ownership and recovery are implemented. */
export const SHARE_ISSUANCE_AVAILABLE = false
export const DEFAULT_DAILY_USD = 20
