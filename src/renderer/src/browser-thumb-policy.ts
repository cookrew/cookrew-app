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

/**
 * Per-id backoff after a failed thumb fetch — the DESKTOP's capture storm fix
 * (capture-backoff.ts: 10s doubling to a 5min cap, reset on success), applied
 * to the phone's polling side. One policy, two surfaces, no drift.
 *
 * The owner's Web Inspector (2026-08-27) caught the failure mode this exists
 * for: after an app restart no browser engine is booted, so every one of 40+
 * browser cards 404s — and the poller re-asked all of them every 5s tick,
 * forever. A phone paid a sustained TLS 404 storm for pictures that could not
 * exist yet; the desktop had already learned this lesson for capturePage()
 * and the polling path never inherited it.
 */
import {
  canCapture,
  initialBackoff,
  recordFailure,
  type CaptureBackoff
} from './capture-backoff'

/** id → its failure backoff. Immutable updates only. */
export type ThumbBackoffs = Readonly<Record<string, CaptureBackoff>>

/** The ids worth asking this tick: everything whose backoff window has passed. */
export function thumbPollList(
  ids: readonly string[],
  backoffs: ThumbBackoffs,
  now: number
): string[] {
  return ids.filter((id) => canCapture(backoffs[id] ?? initialBackoff, now))
}

export function recordThumbFailure(
  backoffs: ThumbBackoffs,
  id: string,
  now: number
): ThumbBackoffs {
  return { ...backoffs, [id]: recordFailure(backoffs[id] ?? initialBackoff, now) }
}

/** A success ends the backoff so a recovered browser refreshes normally. */
export function recordThumbSuccess(backoffs: ThumbBackoffs, id: string): ThumbBackoffs {
  if (!(id in backoffs)) return backoffs
  const { [id]: _gone, ...rest } = backoffs
  return rest
}
