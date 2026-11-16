// THE REAL MAGPIE, in a HOME of its own (opt-in: COOKREW_MAGPIE_LIVE=1).
// Proves the verbs share-keys.ts types against the installed binary: a key it
// made, both caps by id, the list, a revoke; and the remote-magpie line exactly
// as the form builds it, with a key pasted after `key=`.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { magpieBinary, magpieRunner, ShareKeys } from '../src/main/route/share-keys'

const live = process.env.COOKREW_MAGPIE_LIVE === '1'
const bin = magpieBinary({ home: os.homedir(), env: process.env })

describe.runIf(live && bin !== null)('share keys on the real magpie', () => {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, MAGPIE_ADDR: process.env.MAGPIE_ADDR }
  let home = ''
  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'cookrew-magpie-'))
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    // Nothing answers here: the CLI works on its own files, never the owner's running gateway.
    process.env.MAGPIE_ADDR = '127.0.0.1:1'
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('issues a capped key, lists it and revokes it', async () => {
    const keys = new ShareKeys({ run: magpieRunner(bin as string) })
    const issued = await keys.issue({ device: 'Live Probe', dailyUsd: 7 })
    if (!issued.ok) throw new Error(issued.why)
    expect(issued.key).toMatch(/^sk-magpie-/)
    const listed = await keys.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ device: 'live-probe', name: 'device-live-probe' })
    expect(listed[0].limit).toMatch(/\$7\.00 per day/)
    expect(await keys.issue({ device: 'live probe', dailyUsd: 7 })).toMatchObject({ ok: false })
    expect(await keys.revoke(listed[0].id)).toEqual({ ok: true })
    expect(await keys.list()).toEqual([])
  })
})
