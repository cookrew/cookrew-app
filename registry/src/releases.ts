/**
 * THE CURRENT BUILD, from GitHub, cached.
 *
 * The homepage's download buttons and the /download redirect name a real
 * release: whatever `releases/latest` says right now. The answer is cached
 * for an hour and the last good one is kept when GitHub is unreachable, so a
 * GitHub outage degrades to a slightly old link rather than a page with no
 * download on it. Before the first successful read there is nothing to show,
 * and the page says so instead of inventing a version.
 */

export interface ReleaseAsset {
  name: string
  url: string
  bytes: number
}

export interface Release {
  /** `0.1.2` — the tag with its leading v removed. */
  version: string
  tag: string
  publishedAt: string
  /** The release page on GitHub. */
  url: string
  /** Installable assets only; update manifests and blockmaps are dropped. */
  assets: ReleaseAsset[]
}

export const RELEASES_API = 'https://api.github.com/repos/cookrew/cookrew-app/releases/latest'
export const RELEASES_PAGE = 'https://github.com/cookrew/cookrew-app/releases/latest'

/** GitHub's URLs are emitted into a Location header and a page; only https ones are. */
const HTTPS = /^https:\/\/[a-z0-9.-]+\//i
const INSTALLABLE = /\.(dmg|zip|exe|AppImage|deb|rpm|msi)$/i

export class ReleaseCache {
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  private readonly ttlMs: number
  /** How long a failed read is remembered before GitHub is asked again. */
  private readonly missTtlMs: number
  private last: Release | null = null
  private readAt = 0
  private inflight: Promise<Release | null> | null = null

  constructor(options: { fetch?: typeof fetch; ttlMs?: number; missTtlMs?: number } = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000
    this.missTtlMs = options.missTtlMs ?? Math.min(this.ttlMs, 60 * 1000)
  }

  /**
   * The latest release, or null when nothing has ever been read.
   *
   * A stale answer is served at once while a refresh runs behind it; only a
   * cold cache waits on GitHub. The ATTEMPT is what is timestamped, so an
   * outage or a rate limit is asked again after the (shorter) miss interval,
   * not on every page view — a page must not block on a third party.
   */
  async latest(): Promise<Release | null> {
    const age = Date.now() - this.readAt
    const due = this.last === null ? age >= this.missTtlMs : age >= this.ttlMs
    if (!due) return this.last
    if (!this.inflight) {
      this.inflight = this.read().finally(() => {
        this.inflight = null
      })
    }
    return this.last === null ? this.inflight : this.last
  }

  private async read(): Promise<Release | null> {
    this.readAt = Date.now()
    try {
      const res = await this.fetchImpl(RELEASES_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'cookrew-registry' },
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) return this.last
      const parsed = parseRelease(await res.json())
      if (!parsed) return this.last
      this.last = parsed
      return parsed
    } catch {
      return this.last
    }
  }
}

function parseRelease(body: unknown): Release | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = body as {
    tag_name?: unknown
    published_at?: unknown
    html_url?: unknown
    assets?: unknown
  }
  if (typeof raw.tag_name !== 'string' || !Array.isArray(raw.assets)) return null
  const assets: ReleaseAsset[] = []
  for (const asset of raw.assets as { name?: unknown; browser_download_url?: unknown; size?: unknown }[]) {
    if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue
    if (!INSTALLABLE.test(asset.name) || !HTTPS.test(asset.browser_download_url)) continue
    assets.push({
      name: asset.name,
      url: asset.browser_download_url,
      bytes: typeof asset.size === 'number' ? asset.size : 0
    })
  }
  return {
    version: raw.tag_name.replace(/^v/, ''),
    tag: raw.tag_name,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    url: typeof raw.html_url === 'string' && HTTPS.test(raw.html_url) ? raw.html_url : RELEASES_PAGE,
    assets
  }
}

export type Platform = 'mac' | 'windows' | 'other'

/** A platform name, or a browser's user agent read as one. */
export function platformOf(value: string): Platform {
  const v = value.toLowerCase()
  if (v === 'mac' || v === 'windows' || v === 'other') return v
  if (/macintosh|mac os x/.test(v)) return 'mac'
  if (/windows/.test(v)) return 'windows'
  return 'other'
}

/** The installable for a platform: the dmg on a Mac, the exe on Windows. */
export function pickAsset(release: Release, platformOrUserAgent: string): ReleaseAsset | null {
  const platform = platformOf(platformOrUserAgent)
  const want = platform === 'mac' ? /\.dmg$/i : platform === 'windows' ? /\.exe$/i : null
  if (!want) return null
  return release.assets.find((a) => want.test(a.name)) ?? null
}
