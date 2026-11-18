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

/**
 * A key that was being made when something went wrong (main/route/share-intents.ts).
 * It warns until cleared by hand, and can be cleared only once a revoke pass left
 * none of its keys and a process check found no add of its name still running.
 */
export interface PendingKey {
  readonly name: string
  readonly device: string
  readonly at: string
  readonly revoked: { readonly at: string; readonly left: number } | null
  readonly checked: { readonly at: string; readonly live: number } | null
  readonly clearable: boolean
}

/** The key last made, held in main's memory until Done, so a reloaded window can still show it once more. */
export interface ShareHandover {
  readonly id: string
  readonly device: string
  readonly key: string
}

export type ShareListAnswer =
  | {
      readonly ok: true
      readonly keys: readonly SharedKey[]
      readonly where: ShareWhere
      readonly pending: readonly PendingKey[]
      readonly issuing: boolean
      readonly handover: ShareHandover | null
    }
  | { readonly ok: false; readonly why: string }

export type ShareResolveAnswer = { readonly ok: true; readonly left: number; readonly live: number } | { readonly ok: false; readonly why: string }
export const DEFAULT_DAILY_USD = 20
