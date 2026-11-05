/**
 * THE UPDATE CHECK'S WORDS AND RULES.
 *
 * It only ever tells. A found release is a row that opens the download page:
 * nothing is downloaded or installed, and a Mac would refuse to swap in an
 * unsigned build anyway. Main does the asking (main/update-check.ts).
 */

export const RELEASES_API = 'https://api.github.com/repos/cookrew/cookrew-app/releases/latest'
const RELEASE_PAGES = 'https://github.com/cookrew/cookrew-app/releases/'

export const UPDATE_ROW_NOTE = 'Every 6 hours, asks GitHub for the latest version. GitHub sees your IP address, and nothing about your work is sent.'

export interface UpdateRelease {
  readonly version: string
  readonly url: string
}

export interface UpdateStatus {
  readonly on: boolean
  /** A release newer than this build, while the check is on. */
  readonly available: UpdateRelease | null
}

const parts = (version: string): readonly number[] | null => (/^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null)

export function isNewer(candidate: string, current: string): boolean {
  const next = parts(candidate)
  const now = parts(current)
  if (next === null || now === null) return false
  const differs = next.findIndex((part, i) => part !== now[i])
  return differs >= 0 && next[differs] > now[differs]
}

/** A saved or bridged release: stored words are read, never trusted as shaped. */
export function parseUpdateRelease(raw: unknown): UpdateRelease | null {
  const r = raw as Partial<UpdateRelease> | null
  if (typeof r?.version !== 'string' || typeof r.url !== 'string') return null
  // Only this repo's pages: the answer never picks where the browser goes.
  return parts(r.version) !== null && r.url.startsWith(RELEASE_PAGES) ? { version: r.version, url: r.url } : null
}

/** A GitHub answer as a release, or null. */
export function readRelease(raw: unknown): UpdateRelease | null {
  const r = raw as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown } | null
  if (typeof r?.tag_name !== 'string' || r.draft === true || r.prerelease === true) return null
  return parseUpdateRelease({ version: r.tag_name.replace(/^v/, ''), url: r.html_url })
}

/** A status off the bridge: the menu draws from it, so it is read, never trusted as shaped. */
export function parseUpdateStatus(raw: unknown): UpdateStatus | null {
  const s = raw as { on?: unknown; available?: unknown } | null
  if (typeof s?.on !== 'boolean') return null
  return { on: s.on, available: parseUpdateRelease(s.available) }
}
