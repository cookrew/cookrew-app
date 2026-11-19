// MAGPIE'S PAGE, FOR REAL (opt-in: COOKREW_MAGPIE_LIVE=1), in a HOME of its own so the
// owner's Magpie settings are never touched: started by MagpieWeb, signed in through
// the link it hands back, then the bare address opens on the cookie alone.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MagpieWeb } from '../src/main/route/magpie-web'
import { magpieBinary } from '../src/main/route/share-keys'

const live = process.env.COOKREW_MAGPIE_LIVE === '1'
const bin = magpieBinary({ home: os.homedir(), env: process.env })

describe.runIf(live && bin !== null)('Magpie’s page on the real magpie', () => {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, MAGPIE_ADDR: process.env.MAGPIE_ADDR }
  let home = ''
  let web: MagpieWeb | null = null
  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'cookrew-magpie-web-'))
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    process.env.MAGPIE_ADDR = '127.0.0.1:1'
  })
  afterAll(() => {
    web?.stop()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('opens, signs in by the link once, then answers on the cookie alone', async () => {
    web = new MagpieWeb({ bin: () => bin, file: path.join(home, '.cookrew', 'magpie-web.json') })
    const opened = await web.open()
    if (!opened.ok) throw new Error(opened.why)
    const first = await fetch(opened.url, { redirect: 'manual' })
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe('/')
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie).toMatch(new RegExp(`^magpie_web_${opened.port}=`))
    const bare = `http://127.0.0.1:${opened.port}/`
    expect((await fetch(bare, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(bare)).status).toBe(401)
    // Opened again: the same page, the same key, no second process.
    expect(await web.open()).toEqual(opened)
    web.stop()
    await new Promise((r) => setTimeout(r, 500))
    await expect(fetch(bare)).rejects.toThrow()
  }, 60_000)
})
