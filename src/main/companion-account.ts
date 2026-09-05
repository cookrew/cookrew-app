import type { AccountFile } from './account-v2'

/**
 * WHAT THE PHONE MAY KNOW ABOUT THE OWNER'S ACCOUNT.
 *
 * The companion showed a dashed "?" where the avatar should be for the whole
 * of phase 2, because it asked `cookrew().accountStatus` — an ELECTRON channel
 * that does not exist over HTTP. The phone is an attached device of the same
 * account (architecture P6), so it is entitled to the same public face the
 * desktop shows: a name, initials, an avatar.
 *
 * The list is a whitelist and is built member by member rather than by
 * deleting fields from the account file. The account file holds the device
 * PRIVATE KEY, the session token and the unlock verifier; a redaction that is
 * written as "everything except these" is one new field away from shipping a
 * secret to every paired phone, and this one is read by whoever holds the
 * pairing token.
 *
 * The registry origin rides along because the companion needs it and cannot
 * derive it: its own origin is the Mac (or the relay), and "Switch desktop"
 * pointed at a hard-coded cookrew.dev would send a self-hosted owner to
 * somebody else's site.
 *
 * NO NETWORK CALL ON THIS PATH. The display name and avatar live on the
 * registry profile, not in account.json, so they arrive as an optional
 * snapshot that main already had. Without one the initials come from the
 * username, which is local and always there — the phone gets @drej's letters
 * immediately rather than a dashed "?" while a fetch that may never succeed
 * is in flight.
 */

/** The parts of the registry profile the phone is shown, when main has them. */
export type ProfileFace = {
  readonly displayName?: string
  readonly avatar?: string | null
}

export type CompanionAccount = {
  readonly username: string
  readonly displayName: string
  readonly initials: string
  readonly avatar: string | null
  /** The Mac's name and id, so the path sheet can title itself honestly. */
  readonly desktopName: string
  readonly deviceId: string
  readonly registryOrigin: string
}

/**
 * Two letters, the same rule the desktop avatar uses — computed HERE so the
 * two surfaces cannot drift into showing a person different initials
 * depending on which screen they are looking at.
 */
export const initialsOf = (source: string): string => {
  const words = source.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}

/** A data URL, or nothing. An http(s) avatar would be a beacon on every load. */
const safeAvatar = (avatar: unknown): string | null =>
  typeof avatar === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)
    ? avatar
    : null

export const companionAccount = (
  account: AccountFile | null,
  registryOrigin: string,
  face: ProfileFace | null = null
): CompanionAccount | null => {
  if (!account) return null
  const displayName = typeof face?.displayName === 'string' ? face.displayName : ''
  return {
    username: account.username,
    displayName,
    initials: initialsOf(displayName || account.username),
    avatar: safeAvatar(face?.avatar),
    desktopName: account.name,
    deviceId: account.deviceId,
    registryOrigin: registryOrigin.replace(/\/+$/, '')
  }
}
