// MAGPIE'S PAGE IN A CARD, WITH ITS KEY NEVER IN THE CARD. Main signs the card's
// own browser session in (Magpie's cookie, magpie_web_<port> = the key, HttpOnly)
// and hands the renderer only the bare address: nothing the workspace saves, the
// wall or the phone hear, or a log prints can carry the key.
import { describe, expect, it, vi } from 'vitest'
import { openMagpieCardSession, type MagpieCardDeps } from '../src/main/magpie-card-open'

const KEY = 'cookrew-0123456789abcdef0123456789abcdef0123456789abcdef'
const ID = '3f2a6c1e-8b0d-4e55-9a51-2c7d9e0b1a44'

function deps(over: Partial<MagpieCardDeps> = {}): MagpieCardDeps & { partition: ReturnType<typeof vi.fn>; headless: ReturnType<typeof vi.fn> } {
  const partition = vi.fn(async () => {})
  const headless = vi.fn(async () => {})
  return {
    switchedOn: () => true,
    open: async () => ({ ok: true, port: 3433, url: 'http://127.0.0.1:3433/', cookie: { name: 'magpie_web_3433', value: KEY } }),
    setPartitionCookie: partition,
    primeHeadless: headless,
    partition,
    headless,
    ...over
  }
}

describe('openMagpieCardSession', () => {
  it('signs the card’s own sessions in and answers with the bare address only', async () => {
    const d = deps()
    const answer = await openMagpieCardSession(ID, d)
    expect(answer).toEqual({ ok: true, url: 'http://127.0.0.1:3433/', port: 3433 })
    expect(JSON.stringify(answer)).not.toContain(KEY)
    expect(d.partition).toHaveBeenCalledWith(`persist:browser-${ID}`, { url: 'http://127.0.0.1:3433/', name: 'magpie_web_3433', value: KEY, httpOnly: true, sameSite: 'lax' })
    expect(d.headless).toHaveBeenCalledWith(ID, [{ name: 'magpie_web_3433', value: KEY, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax', url: 'http://127.0.0.1:3433/' }])
  })

  it('refuses a card id that is not one, before starting anything', async () => {
    const open = vi.fn()
    for (const bad of ['', '../x', 'a'.repeat(200), 42, null]) {
      expect(await openMagpieCardSession(bad, deps({ open }))).toMatchObject({ ok: false })
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses while Magpie is switched off or the switch cannot be read', async () => {
    const open = vi.fn()
    expect(await openMagpieCardSession(ID, deps({ open, switchedOn: () => false }))).toMatchObject({ ok: false })
    expect(
      await openMagpieCardSession(
        ID,
        deps({
          open,
          switchedOn: () => {
            throw new Error('store gone')
          }
        })
      )
    ).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })

  it('opens nothing when the session cannot be signed in, and never names the key', async () => {
    const answer = await openMagpieCardSession(ID, deps({ setPartitionCookie: async () => Promise.reject(new Error(`cookie ${KEY} refused`)) }))
    expect(answer).toMatchObject({ ok: false })
    expect(JSON.stringify(answer)).not.toContain(KEY)
  })

  it('passes a refusal from the page through without a key', async () => {
    const answer = await openMagpieCardSession(ID, deps({ open: async () => ({ ok: false, why: 'Could not confirm that Magpie’s own page is the one answering on port 3433' }) }))
    expect(answer).toMatchObject({ ok: false, why: expect.stringContaining('Could not confirm') })
  })
})
