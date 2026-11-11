import { describe, expect, it } from 'vitest'
import { parseRelease, pickAsset, type Release } from '../registry/src/releases'

/**
 * THE DOWNLOAD LINKS ARE REAL. The static site names the current build by
 * asking GitHub for the latest release when it is built, and offers the asset
 * for each platform. This is how GitHub's answer is read. (The registry's own
 * cache of it went with the registry's pages in 0.6.0.)
 */

const RELEASE_JSON = {
  tag_name: 'v0.1.2',
  published_at: '2026-08-28T14:05:26Z',
  html_url: 'https://github.com/cookrew/cookrew-app/releases/tag/v0.1.2',
  assets: [
    { name: 'Cookrew-0.1.2-arm64-mac.zip', browser_download_url: 'https://x/zip', size: 1 },
    { name: 'Cookrew-0.1.2-arm64.dmg', browser_download_url: 'https://x/dmg', size: 2 },
    { name: 'Cookrew-0.1.2-windows-preview-x64.exe', browser_download_url: 'https://x/win', size: 3 },
    { name: 'latest-mac.yml', browser_download_url: 'https://x/yml', size: 4 }
  ]
}

describe('reading GitHub’s answer', () => {
  it('reads the version, the date and the installables, and drops the update manifest', () => {
    const release = parseRelease(RELEASE_JSON)
    expect(release?.version).toBe('0.1.2')
    expect(release?.tag).toBe('v0.1.2')
    expect(release?.publishedAt).toBe('2026-08-28T14:05:26Z')
    expect(release?.url).toBe(RELEASE_JSON.html_url)
    expect(release?.assets.map((a) => a.name)).toEqual([
      'Cookrew-0.1.2-arm64-mac.zip',
      'Cookrew-0.1.2-arm64.dmg',
      'Cookrew-0.1.2-windows-preview-x64.exe'
    ])
  })

  it('an answer that is no release is nothing, not a crash', () => {
    expect(parseRelease('nope')).toBeNull()
    expect(parseRelease(null)).toBeNull()
    expect(parseRelease({ tag_name: 'v1' })).toBeNull()
  })
})

describe('picking an asset for a platform', () => {
  const release: Release = {
    version: '0.1.2',
    tag: 'v0.1.2',
    publishedAt: '2026-08-28T14:05:26Z',
    url: 'https://github.com/cookrew/cookrew-app/releases/tag/v0.1.2',
    assets: RELEASE_JSON.assets.slice(0, 3).map((a) => ({ name: a.name, url: a.browser_download_url, bytes: a.size }))
  }
  it('mac gets the dmg, windows the exe, anything else the release page', () => {
    expect(pickAsset(release, 'mac')?.name).toBe('Cookrew-0.1.2-arm64.dmg')
    expect(pickAsset(release, 'windows')?.name).toBe('Cookrew-0.1.2-windows-preview-x64.exe')
    expect(pickAsset(release, 'other')).toBeNull()
  })
  it('a user agent is read as a platform', () => {
    expect(pickAsset(release, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')?.name).toContain('.dmg')
    expect(pickAsset(release, 'Mozilla/5.0 (Windows NT 10.0; Win64)')?.name).toContain('.exe')
    expect(pickAsset(release, 'Mozilla/5.0 (X11; Linux x86_64)')).toBeNull()
  })
})
