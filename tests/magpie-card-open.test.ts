// MAGPIE'S PAGE IN A CARD, WITH ITS KEY NEVER IN THE CARD. Main signs the card's
// own browser session in (Magpie's cookie, magpie_web_<port> = the key, HttpOnly)
// and hands the renderer only the bare address. Which card is signed in is main's
// call: one it signed before, else a new id it mints, never a card merely named
// "Magpie". In the card's webview session the cookie is held back from any other
// port on loopback.
import { describe, expect, it, vi } from 'vitest'
import { cookieAllowedFor, openMagpieCardSession, stripMagpieCookies, type MagpieCardDeps } from '../src/main/magpie-card-open'

const KEY = 'cookrew-0123456789abcdef0123456789abcdef0123456789abcdef'
const ID = '3f2a6c1e-8b0d-4e55-9a51-2c7d9e0b1a44'

function deps(over: Partial<MagpieCardDeps> = {}): MagpieCardDeps & { partition: ReturnType<typeof vi.fn>; headless: ReturnType<typeof vi.fn>; guard: ReturnType<typeof vi.fn>; signedIds: string[] } {
  const partition = vi.fn(async () => {})
  const headless = vi.fn(async () => {})
  const guard = vi.fn()
  const signedIds: string[] = []
  return {
    switchedOn: () => true,
    open: async () => ({ ok: true, port: 3433, url: 'http://127.0.0.1:3433/', cookie: { name: 'magpie_web_3433', value: KEY } }),
    setPartitionCookie: partition,
    guardPartition: guard,
    primeHeadless: headless,
    signed: { has: (id) => signedIds.includes(id), add: (id) => void signedIds.push(id) },
    newId: () => ID,
    partition,
    headless,
    guard,
    signedIds,
    ...over
  }
}

describe('openMagpieCardSession', () => {
  it('mints a card id when no card it signed is offered, signs that card in, and answers with the bare address only', async () => {
    const d = deps()
    const answer = await openMagpieCardSession(['agent-made-card'], d)
    expect(answer).toEqual({ ok: true, url: 'http://127.0.0.1:3433/', port: 3433, cardId: ID, fresh: true })
    expect(JSON.stringify(answer)).not.toContain(KEY)
    expect(d.partition).toHaveBeenCalledWith(`persist:browser-${ID}`, { url: 'http://127.0.0.1:3433/', name: 'magpie_web_3433', value: KEY, httpOnly: true, sameSite: 'lax' })
    expect(d.guard).toHaveBeenCalledWith(`persist:browser-${ID}`, 3433)
    expect(d.headless).toHaveBeenCalledWith(ID, [{ name: 'magpie_web_3433', value: KEY, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax', url: 'http://127.0.0.1:3433/' }])
    expect(d.signedIds).toEqual([ID])
  })

  it('reuses a card it signed before, and never one it did not', async () => {
    const d = deps()
    d.signedIds.push('mine-before')
    expect(await openMagpieCardSession(['agent-made-card', 'mine-before'], d)).toMatchObject({ ok: true, cardId: 'mine-before', fresh: false })
    expect(d.partition).toHaveBeenCalledWith('persist:browser-mine-before', expect.anything())
  })

  it('refuses offers that are not card ids, before starting anything', async () => {
    const open = vi.fn()
    for (const bad of ['x', ['../x'], ['a'.repeat(200)], [42], null, Array.from({ length: 50 }, (_, i) => `c${i}`)]) {
      expect(await openMagpieCardSession(bad, deps({ open }))).toMatchObject({ ok: false })
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses while Magpie is switched off or the switch cannot be read', async () => {
    const open = vi.fn()
    expect(await openMagpieCardSession([], deps({ open, switchedOn: () => false }))).toMatchObject({ ok: false })
    expect(await openMagpieCardSession([], deps({ open, switchedOn: () => { throw new Error('store gone') } }))).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })

  it('opens nothing when the session cannot be signed in, and never names the key', async () => {
    const answer = await openMagpieCardSession([], deps({ setPartitionCookie: async () => Promise.reject(new Error(`cookie ${KEY} refused`)) }))
    expect(answer).toMatchObject({ ok: false })
    expect(JSON.stringify(answer)).not.toContain(KEY)
  })
})

describe('the cookie stays on its own port', () => {
  it('sends a magpie_web cookie only to the port it names', () => {
    expect(cookieAllowedFor('http://127.0.0.1:3433/x', 3433)).toBe(true)
    expect(cookieAllowedFor('http://127.0.0.1:8080/', 3433)).toBe(false)
    expect(cookieAllowedFor('http://localhost:3433/', 3433)).toBe(false)
    expect(cookieAllowedFor('not a url', 3433)).toBe(false)
  })

  it('takes every magpie_web cookie out of a Cookie header, and keeps the rest', () => {
    expect(stripMagpieCookies('a=1; magpie_web_3433=secret; b=2')).toBe('a=1; b=2')
    expect(stripMagpieCookies('magpie_web_3433=secret')).toBe('')
    expect(stripMagpieCookies('a=1')).toBe('a=1')
  })
})
