// A KEPT COOKIE GOES BACK INTO A CARD'S CHROME (card-cookie-restore.ts) before
// the first page loads: as the same cookie (host-only stays host-only), only
// where Chrome did not keep its own, never over a cookie main primed, and
// never by failing the start.
import { describe, expect, it, vi } from 'vitest'
import { cookieParamFor, vaultCookieFrom, type VaultCookie } from '../src/main/card-cookie-shape'
import { restoreCardCookies } from '../src/main/card-cookie-restore'
import type { HeadlessCookie } from '../src/main/headless-chrome'

const SESSION: VaultCookie = { name: 'login_aliyunid_ticket', value: 'T-1', domain: '.aliyun.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }
const HOST_ONLY: VaultCookie = { name: '__Host-sid', value: 'h-1', domain: 'signin.aliyun.com', path: '/', expires: 4102444800, httpOnly: true, secure: true, sameSite: 'Lax' }
const PRIMED: HeadlessCookie = { name: 'magpie_web_3433', value: 'new-key', url: 'http://127.0.0.1:3433/', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }

describe('vaultCookieFrom', () => {
  it('keeps a session cookie a session cookie', () => {
    expect(vaultCookieFrom({ ...SESSION, expires: -1, session: true })).toEqual(SESSION)
  })

  it('refuses what is not a cookie', () => {
    expect(vaultCookieFrom(null)).toBeNull()
    expect(vaultCookieFrom('a=b')).toBeNull()
    expect(vaultCookieFrom({ name: 'a', value: 1, domain: 'x', path: '/' })).toBeNull()
    expect(vaultCookieFrom({ name: 'a', value: 'b', domain: '', path: '/' })).toBeNull()
    expect(vaultCookieFrom({ name: 'a', value: 'b', domain: 'x', path: 'no-slash' })).toBeNull()
  })

  it('drops a sameSite or a partitionKey it does not know rather than the cookie', () => {
    const odd = vaultCookieFrom({ ...SESSION, sameSite: 'Sideways', partitionKey: { topLevelSite: 7 } })
    const { sameSite: _unknown, ...rest } = SESSION
    expect(odd).toEqual(rest)
  })

  it('keeps an older Chrome string partitionKey', () => {
    expect(vaultCookieFrom({ ...SESSION, partitionKey: 'https://example.com' })?.partitionKey).toBe('https://example.com')
  })
})

describe('cookieParamFor', () => {
  it('sets a domain cookie by its domain', () => {
    expect(cookieParamFor(SESSION)).toEqual({ name: 'login_aliyunid_ticket', value: 'T-1', domain: '.aliyun.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' })
  })

  it('sets a host-only cookie by url, so it stays host-only and a __Host- prefix is honoured', () => {
    const param = cookieParamFor(HOST_ONLY)
    expect(param.domain).toBeUndefined()
    expect(param.url).toBe('https://signin.aliyun.com/')
    expect(param.expires).toBe(4102444800)
  })

  it('uses http for a host-only cookie that is not secure', () => {
    expect(cookieParamFor({ ...HOST_ONLY, name: 'x', secure: false, path: '/app' }).url).toBe('http://signin.aliyun.com/app')
  })
})

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

function chrome(existing: unknown[] = [], refuse: (cookies: HeadlessCookie[]) => boolean = () => false) {
  const set: HeadlessCookie[][] = []
  const send = vi.fn<Send>(async (method, params) => {
    if (method === 'Storage.getCookies') return { cookies: existing }
    if (method === 'Storage.setCookies') {
      const cookies = (params?.cookies ?? []) as HeadlessCookie[]
      if (refuse(cookies)) throw new Error('Invalid cookie fields')
      set.push(cookies)
      return {}
    }
    throw new Error(`unexpected ${method}`)
  })
  return { send, set }
}

describe('restoreCardCookies', () => {
  it('sets every kept cookie in one call when Chrome has none of them', async () => {
    const c = chrome()
    expect(await restoreCardCookies(c.send, [SESSION, HOST_ONLY], [])).toBe(2)
    expect(c.set).toEqual([[cookieParamFor(SESSION), cookieParamFor(HOST_ONLY)]])
  })

  it('leaves a cookie Chrome kept itself to Chrome', async () => {
    const c = chrome([{ ...HOST_ONLY, value: 'newer', size: 9, session: false }])
    expect(await restoreCardCookies(c.send, [SESSION, HOST_ONLY], [])).toBe(1)
    expect(c.set).toEqual([[cookieParamFor(SESSION)]])
  })

  it('never sets a kept cookie over one main primed (same name, domain and path)', async () => {
    const c = chrome()
    const stale: VaultCookie = { name: PRIMED.name, value: 'old-key', domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }
    expect(await restoreCardCookies(c.send, [stale, SESSION], [PRIMED])).toBe(1)
    expect(c.set.flat().map((x) => x.name)).toEqual([SESSION.name])
  })

  it('keeps partitioned cookies of the same name apart', async () => {
    const a: VaultCookie = { ...SESSION, partitionKey: { topLevelSite: 'https://a.example', hasCrossSiteAncestor: false } }
    const c = chrome([{ ...SESSION, partitionKey: { topLevelSite: 'https://b.example', hasCrossSiteAncestor: false } }])
    expect(await restoreCardCookies(c.send, [a], [])).toBe(1)
  })

  it('falls back to one cookie at a time when Chrome refuses the batch, and says how many it refused', async () => {
    const bad: VaultCookie = { ...SESSION, name: 'bad' }
    const c = chrome([], (cookies) => cookies.some((x) => x.name === 'bad'))
    const lines: string[] = []
    expect(await restoreCardCookies(c.send, [SESSION, bad, HOST_ONLY], [], (line) => lines.push(line))).toBe(2)
    expect(c.set.map((batch) => batch.map((x) => x.name))).toEqual([[SESSION.name], [HOST_ONLY.name]])
    expect(lines.join('\n')).toMatch(/1 of 3/)
    expect(lines.join('\n')).not.toContain('T-1')
  })

  it('restores nothing, and does not throw, when Chrome cannot list its cookies', async () => {
    const send = vi.fn<Send>(async () => {
      throw new Error('socket closed')
    })
    await expect(restoreCardCookies(send, [SESSION], [], () => undefined)).resolves.toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not ask Chrome anything when there is nothing kept', async () => {
    const c = chrome()
    expect(await restoreCardCookies(c.send, [], [PRIMED])).toBe(0)
    expect(c.send).not.toHaveBeenCalled()
  })
})
