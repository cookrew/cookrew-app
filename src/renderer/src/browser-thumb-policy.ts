/**
 * Who draws a browser card's picture, per client.
 *
 * There are two producers and the wrong pairing leaves every browser card on
 * its placeholder — which is what the phone showed: it polled /thumb ONLY with
 * the interactive flag off, so with the flag on (headless browsers) a phone
 * had no producer at all. The flag decides which producer main uses, NOT
 * whether the phone should ask; a remote client always asks main, because it
 * has no local page of its own to photograph either way.
 */
export interface ThumbSource {
  /** This client is the phone/LAN companion, not the desktop shell. */
  remote: boolean
  /** Headless browser ownership: true/false once known, null while resolving. */
  interactive: boolean | null
}

/** Poll main's `/api/browser/:id/thumb` for card pictures. */
export function shouldPollThumbs({ remote, interactive }: ThumbSource): boolean {
  // Unresolved ownership: a frame fetched now could be the other owner's
  // leftover, and a stale picture is worse than none.
  return remote && interactive !== null
}

/** Capture the local headless page over IPC — desktop only, flag on. */
export function shouldSnapshotLocally({ remote, interactive }: ThumbSource): boolean {
  return !remote && interactive === true
}

/**
 * Drop retained frames when ownership resolves to headless. Only the desktop
 * holds legacy webview frames that could go stale this way; on a remote client
 * the same clear would wipe (and revoke) the pictures it just polled.
 */
export function shouldClearLegacyThumbs({ remote, interactive }: ThumbSource): boolean {
  return !remote && interactive === true
}
