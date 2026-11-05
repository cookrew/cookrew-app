// THE UPDATE CHECK: one small question to GitHub, on a timer, and the one thing
// that may come of it is a row that opens the download page. Nothing is
// downloaded or installed here.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOT_DELAY_MS, CHECK_EVERY_MS, RETRY_MS, createUpdateCheck, type UpdateInstaller } from '../src/main/update-check'
import { isNewer, readRelease, parseUpdateStatus } from '../src/shared/update-check'

const page = (tag: string): string => `https://github.com/cookrew/cookrew-app/releases/tag/${tag}`
const release = (tag: string): Record<string, unknown> => ({ tag_name: tag, html_url: page(tag), draft: false, prerelease: false })

describe('isNewer', () => {
  it('compares numbers, not strings', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
  })

  it('the same or an older version is no update', () => {
    expect(isNewer('0.4.0', '0.4.0')).toBe(false)
    expect(isNewer('0.3.9', '0.4.0')).toBe(false)
  })

  it('a version it cannot read is no update', () => {
    expect(isNewer('nightly', '0.4.0')).toBe(false)
    expect(isNewer('0.5.0', 'dev')).toBe(false)
  })
})

describe('readRelease', () => {
  it('reads a published release, without the v', () => {
    expect(readRelease(release('v0.5.0'))).toEqual({ version: '0.5.0', url: page('v0.5.0') })
  })

  it('refuses drafts, prereleases and suffixed tags', () => {
    expect(readRelease({ ...release('v0.5.0'), draft: true })).toBeNull()
    expect(readRelease({ ...release('v0.5.0'), prerelease: true })).toBeNull()
    expect(readRelease(release('v0.5.0-beta.1'))).toBeNull()
  })

  it('opens only this repo: a feed answer never picks where the browser goes', () => {
    expect(readRelease({ ...release('v0.5.0'), html_url: 'https://evil.example/cookrew-app/releases/tag/v0.5.0' })).toBeNull()
    expect(readRelease({ ...release('v0.5.0'), html_url: 'https://github.com/someone/else/releases/tag/v0.5.0' })).toBeNull()
  })

  it('survives an answer that is not a release', () => {
    expect(readRelease(null)).toBeNull()
    expect(readRelease({ message: 'API rate limit exceeded' })).toBeNull()
  })
})

describe('parseUpdateStatus', () => {
  it('keeps a status, and refuses a shape it cannot draw', () => {
    const status = { on: true, auto: true, install: 'ready', available: { version: '0.5.0', url: page('v0.5.0') } }
    expect(parseUpdateStatus(status)).toEqual(status)
    expect(parseUpdateStatus({ on: true, available: null })).toEqual({ on: true, auto: false, install: 'page', available: null })
    expect(parseUpdateStatus({ ...status, install: 'teleport' })?.install).toBe('page')
    expect(parseUpdateStatus({ ok: false })).toBeNull()
    expect(parseUpdateStatus(null)).toBeNull()
  })
})

describe('createUpdateCheck', () => {
  let dir = ''
  let file = ''
  let now = 0
  let timers: { at: number; fn: () => void }[] = []

  const schedule = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: now + ms, fn }
    timers = [...timers, timer]
    return () => {
      timers = timers.filter((t) => t !== timer)
    }
  }
  /** Runs what is due, and lets the answer land. */
  const pass = async (ms: number): Promise<void> => {
    now += ms
    const due = timers.filter((t) => t.at <= now)
    timers = timers.filter((t) => t.at > now)
    due.forEach((t) => t.fn())
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }
  const answer = (body: unknown, status = 200): typeof fetch => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  const make = (fetcher: typeof fetch, publish: (s: unknown) => void = () => undefined, installer?: UpdateInstaller) =>
    createUpdateCheck({ version: '0.4.0', file, fetch: fetcher, publish, now: () => now, schedule, installer })
  const installs = (over: Partial<UpdateInstaller> = {}): UpdateInstaller => ({
    supported: vi.fn(async () => true),
    fetch: vi.fn(async () => '0.5.0'),
    install: vi.fn(),
    ...over
  })

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'update-check-'))
    file = path.join(dir, 'update-check.json')
    now = 1_800_000_000_000
    timers = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is on by default, and asks nothing before the app has settled', async () => {
    const fetcher = answer(release('v0.5.0'))
    const check = make(fetcher)
    check.start()
    expect(check.status()).toMatchObject({ on: true, available: null })
    await pass(BOOT_DELAY_MS - 1)
    expect(fetcher).not.toHaveBeenCalled()
    await pass(1)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('a newer release becomes the row, and the page hears at once', async () => {
    const publish = vi.fn()
    const check = make(answer(release('v0.5.0')), publish)
    check.start()
    await pass(BOOT_DELAY_MS)
    const status = { on: true, auto: false, install: 'page', available: { version: '0.5.0', url: page('v0.5.0') } }
    expect(check.status()).toEqual(status)
    expect(publish).toHaveBeenLastCalledWith(status)
  })

  it('the version already running is no news', async () => {
    const check = make(answer(release('v0.4.0')))
    check.start()
    await pass(BOOT_DELAY_MS)
    expect(check.status().available).toBeNull()
  })

  it('asks again on the timer, not sooner', async () => {
    const fetcher = answer(release('v0.4.0'))
    make(fetcher).start()
    await pass(BOOT_DELAY_MS)
    await pass(CHECK_EVERY_MS - 1)
    expect(fetcher).toHaveBeenCalledOnce()
    await pass(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('a restart does not ask again early: the last check is remembered', async () => {
    const first = answer(release('v0.4.0'))
    make(first).start()
    await pass(BOOT_DELAY_MS)
    const second = answer(release('v0.4.0'))
    make(second).start()
    await pass(BOOT_DELAY_MS)
    expect(second).not.toHaveBeenCalled()
    await pass(CHECK_EVERY_MS)
    expect(second).toHaveBeenCalledOnce()
  })

  it('a failure stays quiet, keeps what it knew, and tries again sooner', async () => {
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(release('v0.5.0')))).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response(JSON.stringify(release('v0.6.0'))))
    const check = make(down as unknown as typeof fetch)
    check.start()
    await pass(BOOT_DELAY_MS)
    await pass(CHECK_EVERY_MS)
    expect(check.status().available?.version).toBe('0.5.0')
    await pass(RETRY_MS)
    expect(check.status().available?.version).toBe('0.6.0')
  })

  it('a refused answer is a failure too, never an empty release', async () => {
    const check = make(answer({ message: 'API rate limit exceeded' }, 403))
    check.start()
    await pass(BOOT_DELAY_MS)
    expect(check.status().available).toBeNull()
    expect(timers.map((t) => t.at - now)).toEqual([RETRY_MS])
  })

  it('off stops the timer and hides the row, and stays off after a restart', async () => {
    const fetcher = answer(release('v0.5.0'))
    const check = make(fetcher)
    check.start()
    await pass(BOOT_DELAY_MS)
    expect(check.setOn(false)).toMatchObject({ on: false, available: null })
    expect(timers).toEqual([])
    const again = make(fetcher)
    again.start()
    expect(again.status().on).toBe(false)
    expect(timers).toEqual([])
  })

  it('an answer that lands after off is dropped', async () => {
    let land: (r: Response) => void = () => undefined
    const slow = vi.fn(() => new Promise<Response>((resolve) => (land = resolve))) as unknown as typeof fetch
    const publish = vi.fn()
    const check = make(slow, publish)
    check.start()
    await pass(BOOT_DELAY_MS)
    check.setOn(false)
    publish.mockClear()
    land(new Response(JSON.stringify(release('v0.5.0'))))
    await pass(0)
    expect(publish).not.toHaveBeenCalled()
    expect(timers).toEqual([])
    expect(check.setOn(true).available).toBeNull()
  })

  it('on asks at once rather than waiting out the day', async () => {
    const fetcher = answer(release('v0.5.0'))
    const check = make(fetcher)
    check.start()
    check.setOn(false)
    check.setOn(true)
    await pass(0)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('an update already installed stops being one', async () => {
    writeFileSync(file, JSON.stringify({ on: true, checkedAt: now, latest: { version: '0.4.0', url: page('v0.4.0') } }))
    const check = make(answer(release('v0.4.0')))
    expect(check.status().available).toBeNull()
  })

  it('a broken file reads as a fresh start', () => {
    writeFileSync(file, 'not json')
    expect(make(answer(release('v0.4.0'))).status()).toMatchObject({ on: true, available: null })
  })

  it('sends no identity: no cookie, no token, only what GitHub requires', async () => {
    const fetcher = answer(release('v0.4.0'))
    make(fetcher).start()
    await pass(BOOT_DELAY_MS)
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/cookrew/cookrew-app/releases/latest')
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(['Accept', 'User-Agent'])
    expect(JSON.parse(readFileSync(file, 'utf8')).on).toBe(true)
  })

  describe('a build that can install itself', () => {
    it('says so as soon as it knows, before anything is found', async () => {
      const check = make(answer(release('v0.4.0')), undefined, installs())
      expect(check.status().auto).toBe(false)
      check.start()
      await pass(0)
      expect(check.status().auto).toBe(true)
    })

    it('downloads a newer release by itself, then offers the restart', async () => {
      let land: (version: string) => void = () => undefined
      const installer = installs({ fetch: vi.fn(() => new Promise<string>((resolve) => (land = resolve))) })
      const publish = vi.fn()
      const check = make(answer(release('v0.5.0')), publish, installer)
      check.start()
      await pass(BOOT_DELAY_MS)
      expect(check.status().install).toBe('downloading')
      land('0.5.0')
      await pass(0)
      expect(check.status().install).toBe('ready')
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ install: 'ready' }))
    })

    it('never restarts on its own: only the owner’s press installs', async () => {
      const installer = installs()
      const check = make(answer(release('v0.5.0')), undefined, installer)
      check.start()
      await pass(BOOT_DELAY_MS)
      await pass(CHECK_EVERY_MS)
      expect(installer.install).not.toHaveBeenCalled()
      expect(check.restart()).toBe(true)
      expect(installer.install).toHaveBeenCalledOnce()
    })

    it('refuses a restart with nothing downloaded', async () => {
      const installer = installs()
      const check = make(answer(release('v0.4.0')), undefined, installer)
      check.start()
      await pass(BOOT_DELAY_MS)
      expect(check.restart()).toBe(false)
      expect(installer.install).not.toHaveBeenCalled()
    })

    it('a failed download falls back to the release page, and the next check tries again', async () => {
      const fetcher = vi.fn<UpdateInstaller['fetch']>().mockRejectedValueOnce(new Error('read-only volume')).mockResolvedValue('0.5.0')
      const check = make(
        vi.fn(async () => new Response(JSON.stringify(release('v0.5.0')))) as unknown as typeof fetch,
        undefined,
        installs({ fetch: fetcher })
      )
      check.start()
      await pass(BOOT_DELAY_MS)
      expect(check.status()).toMatchObject({ install: 'page', available: { version: '0.5.0' } })
      await pass(CHECK_EVERY_MS)
      expect(check.status().install).toBe('ready')
    })

    it('a download of another version is not this update', async () => {
      const check = make(answer(release('v0.5.0')), undefined, installs({ fetch: vi.fn(async () => '0.4.9') }))
      check.start()
      await pass(BOOT_DELAY_MS)
      expect(check.status().install).toBe('page')
    })

    it('does not download what it already holds', async () => {
      const installer = installs()
      const check = make(vi.fn(async () => new Response(JSON.stringify(release('v0.5.0')))) as unknown as typeof fetch, undefined, installer)
      check.start()
      await pass(BOOT_DELAY_MS)
      await pass(CHECK_EVERY_MS)
      expect(installer.fetch).toHaveBeenCalledOnce()
    })

    it('a build that cannot install itself only ever offers the page', async () => {
      const installer = installs({ supported: vi.fn(async () => false) })
      const check = make(answer(release('v0.5.0')), undefined, installer)
      check.start()
      await pass(BOOT_DELAY_MS)
      expect(check.status()).toMatchObject({ auto: false, install: 'page', available: { version: '0.5.0' } })
      expect(installer.fetch).not.toHaveBeenCalled()
    })

    it('off downloads nothing', async () => {
      const installer = installs()
      const check = make(answer(release('v0.5.0')), undefined, installer)
      check.start()
      check.setOn(false)
      await pass(BOOT_DELAY_MS)
      expect(installer.fetch).not.toHaveBeenCalled()
    })

    it('picks up a release it already knew about soon after launch, not six hours later', async () => {
      writeFileSync(file, JSON.stringify({ on: true, checkedAt: now, latest: { version: '0.5.0', url: page('v0.5.0') } }))
      const installer = installs()
      const check = make(answer(release('v0.5.0')), undefined, installer)
      check.start()
      await pass(BOOT_DELAY_MS)
      expect(check.status().install).toBe('ready')
    })
  })
})
