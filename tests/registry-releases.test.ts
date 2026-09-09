import { describe, expect, it } from 'vitest'
import { ReleaseCache, pickAsset, type Release } from '../registry/src/releases'

/**
 * THE DOWNLOAD LINKS ARE REAL. The homepage names the current build by asking
 * GitHub for the latest release, and /download sends a reader to the asset
 * for their platform. A page that hard-coded a version would advertise an old
 * one within a week, so the cache refreshes and falls back to the last good
 * answer when GitHub is unreachable.
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

const fetchOk = async (): Promise<Response> =>
  new Response(JSON.stringify(RELEASE_JSON), { status: 200, headers: { 'content-type': 'application/json' } })

describe('the release cache', () => {
  it('reads the latest release once and answers from memory', async () => {
    let calls = 0
    const cache = new ReleaseCache({
      fetch: async () => {
        calls++
        return fetchOk()
      },
      ttlMs: 60_000
    })
    const first = await cache.latest()
    const second = await cache.latest()
    expect(calls).toBe(1)
    expect(first?.version).toBe('0.1.2')
    expect(first?.publishedAt).toBe('2026-08-28T14:05:26Z')
    expect(second).toEqual(first)
    expect(first?.assets.map((a) => a.name)).toEqual([
      'Cookrew-0.1.2-arm64-mac.zip',
      'Cookrew-0.1.2-arm64.dmg',
      'Cookrew-0.1.2-windows-preview-x64.exe'
    ])
  })

  it('keeps the last good answer when GitHub fails, and null before any', async () => {
    let fail = false
    const cache = new ReleaseCache({
      fetch: async () => (fail ? new Response('nope', { status: 503 }) : fetchOk()),
      ttlMs: 0
    })
    expect(await cache.latest()).not.toBeNull()
    fail = true
    expect((await cache.latest())?.version).toBe('0.1.2')
    const cold = new ReleaseCache({ fetch: async () => new Response('nope', { status: 503 }), ttlMs: 0 })
    expect(await cold.latest()).toBeNull()
  })

  it('a throwing fetch is a miss, not a crash', async () => {
    const cache = new ReleaseCache({
      fetch: async () => {
        throw new Error('offline')
      },
      ttlMs: 0
    })
    expect(await cache.latest()).toBeNull()
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
