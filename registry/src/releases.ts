/**
 * THE CURRENT BUILD, as GitHub names it.
 *
 * The static site's download buttons name a real release: whatever
 * `releases/latest` said when the site was built (scripts/site-build.mjs).
 * This is how that answer is read, and how the installable for a platform is
 * picked out of it. Before a successful read there is nothing to show, and
 * the page says so instead of inventing a version.
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

/** GitHub's URLs are emitted into a page; only https ones are. */
const HTTPS = /^https:\/\/[a-z0-9.-]+\//i
const INSTALLABLE = /\.(dmg|zip|exe|AppImage|deb|rpm|msi)$/i

/** GitHub's answer for one release, read as far as it is one. */
export function parseRelease(body: unknown): Release | null {
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
