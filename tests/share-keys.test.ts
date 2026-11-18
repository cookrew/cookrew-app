import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { shareHandlers } from '../src/main/share-ipc'
import { gatewayOnNetwork, parseKeyTable, shareUrls, ShareKeys as RealShareKeys, type MagpieRun } from '../src/main/route/share-keys'
import { memoryIntentStore } from '../src/main/route/share-intents'

/** Every ShareKeys here writes its intents to memory (share-key-recovery.test.ts covers the file). */
class ShareKeys extends RealShareKeys {
  constructor(deps: { run: MagpieRun }) {
    super({ ...deps, intents: memoryIntentStore(), processes: async () => [] })
  }
}

const TABLE = `ID                        NAME           STATE    GATEWAY KEY            LIMIT                 MODELS                                    ACCOUNTS  ACCESS
9ed61cf285e943f9a28bfb6a  solis-compare  enabled  sk-magpie-key-…5102ac  $0.00/$20.00 per day  claude/claude-opus-5-5,codex/gpt-6.1-sol  all       full
7133291de0e0a098f9496f86  device-solis   enabled  sk-magpie-key-…aa11bb  $1.25/$20.00 per day  all                                       all       full
`

describe('parseKeyTable', () => {
  it('reads id, name and limit off Magpie’s table', () => {
    expect(parseKeyTable(TABLE)).toEqual([
      { id: '9ed61cf285e943f9a28bfb6a', name: 'solis-compare', limit: '$0.00/$20.00 per day', tail: '5102ac', state: 'enabled' },
      { id: '7133291de0e0a098f9496f86', name: 'device-solis', limit: '$1.25/$20.00 per day', tail: 'aa11bb', state: 'enabled' }
    ])
  })
  it('reads a dash as no limit, and an empty list as nothing', () => {
    expect(parseKeyTable('ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS\n')).toEqual([])
    expect(parseKeyTable('ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS\nabc12345abc12345abc12345  device-x  enabled  sk-…1  -  all  all  full\n')[0].limit).toBeNull()
    expect(() => parseKeyTable('')).toThrow()
    expect(() => parseKeyTable('unexpected format')).toThrow()
    expect(() => parseKeyTable('ID  NAME  EXPIRES\n')).toThrow()
    expect(() => parseKeyTable('ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS\n')).toThrow()
    expect(() => parseKeyTable('error: incomplete\nID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS\n')).toThrow()
    expect(() => parseKeyTable('ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS')).toThrow()
    expect(() => parseKeyTable('ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS\nbroken row\n')).toThrow()
  })
})

/** A Magpie that keeps its keys in memory, and the calls it was given. */
function fakeMagpie(opts: { failLimit?: boolean; key?: string; failListAt?: number; slow?: boolean } = {}): { run: MagpieRun; calls: string[][]; rows: { id: string; name: string; tail?: string }[] } {
  const rows: { id: string; name: string; tail?: string }[] = [{ id: '9ed61cf285e943f9a28bfb6a', name: 'solis-compare' }]
  const made = opts.key ?? 'sk-magpie-' + 'k'.repeat(52)
  const calls: string[][] = []
  let lists = 0
  let adds = 0
  const run: MagpieRun = async (args) => {
    calls.push(args)
    if (opts.slow) await new Promise((resolve) => setTimeout(resolve, 5))
    const [, verb, a1] = args
    if (verb === 'list') {
      lists += 1
      if (lists === opts.failListAt) throw new Error('magpie list timed out')
      const lines = rows.map((r) => `${r.id}  ${r.name}  enabled  sk-magpie-key-…${r.tail ?? 'xxxxxx'}  -  all  all  full`)
      return { code: 0, stdout: `ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS\n${lines.join('\n')}\n`, stderr: '' }
    }
    if (verb === 'add') {
      adds += 1
      rows.push({ id: (adds === 1 ? 'f' : String(adds)).repeat(24).slice(0, 24), name: a1, tail: made.split('\n')[0].slice(-6) })
      return { code: 0, stdout: `${made}\n`, stderr: '' }
    }
    if (verb === 'limit' && opts.failLimit) return { code: 1, stdout: '', stderr: 'magpie: Key not found' }
    if (verb === 'remove') {
      const at = rows.findIndex((r) => r.id === a1)
      if (at >= 0) rows.splice(at, 1)
      return { code: 0, stdout: 'Gateway key removed\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, rows }
}

describe('share IPC switches', () => {
  it('takes back a key when remote is switched off during issuance', async () => {
    const magpie = fakeMagpie()
    let enabled = true
    const run: MagpieRun = async (args) => {
      const result = await magpie.run(args)
      if (args[1] === 'add') enabled = false
      return result
    }
    const handlers = shareHandlers({ keys: new ShareKeys({ run }), enabled: () => ({ magpie: true, magpieRemote: enabled }) })
    const answer = await handlers.issue({ device: 'laptop', dailyUsd: 5 })
    expect(answer.ok).toBe(false)
    expect(magpie.rows.some((row) => row.name === 'device-laptop')).toBe(false)
  })

  it('does not start a queued issue after remote is switched off', async () => {
    const magpie = fakeMagpie({ slow: true })
    let enabled = true
    const handlers = shareHandlers({ keys: new ShareKeys({ run: magpie.run }), enabled: () => ({ magpie: true, magpieRemote: enabled }) })
    const first = handlers.issue({ device: 'laptop', dailyUsd: 5 })
    const second = handlers.issue({ device: 'phone', dailyUsd: 5 })
    enabled = false
    expect((await first).ok).toBe(false)
    expect((await second).ok).toBe(false)
    expect(magpie.calls.filter((args) => args[1] === 'add')).toEqual([])
  })
  it('serializes overlapping issues through the same production-style key manager', async () => {
    const magpie = fakeMagpie({ slow: true })
    let made = 0
    const handlers = shareHandlers({
      makeKeys: () => { made += 1; return new ShareKeys({ run: magpie.run }) },
      enabled: () => ({ magpie: true, magpieRemote: true })
    })
    const [first, second] = await Promise.all([
      handlers.issue({ device: 'laptop', dailyUsd: 5 }),
      handlers.issue({ device: 'laptop', dailyUsd: 5 })
    ])
    expect(made).toBe(1)
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    expect(magpie.rows.filter((row) => row.name.startsWith('device-laptop--'))).toHaveLength(1)
  })
  it('checks both switches at every issue and permits revocation while disabled', async () => {
    const magpie = fakeMagpie()
    magpie.rows.push({ id: 'a'.repeat(24), name: 'device-solis' })
    let switches = { magpie: true, magpieRemote: false }
    const handlers = shareHandlers({ keys: new ShareKeys({ run: magpie.run }), enabled: () => switches })
    expect((await handlers.issue({ device: 'laptop', dailyUsd: 5 })).ok).toBe(false)
    expect(magpie.calls).toEqual([])
    switches = { magpie: false, magpieRemote: true }
    expect((await handlers.issue({ device: 'laptop', dailyUsd: 5 })).ok).toBe(false)
    switches = { magpie: true, magpieRemote: true }
    expect((await handlers.issue({ device: 'laptop', dailyUsd: 5 })).ok).toBe(true)
    switches = { magpie: false, magpieRemote: false }
    expect(await handlers.revoke('a'.repeat(24))).toEqual({ ok: true })
  })
})

describe('ShareKeys', () => {
  it('lists only the keys it made for devices', async () => {
    const magpie = fakeMagpie()
    magpie.rows.push({ id: 'a'.repeat(24), name: 'device-solis' })
    expect((await new ShareKeys({ run: magpie.run }).list()).keys).toEqual([{ id: 'a'.repeat(24), name: 'device-solis', device: 'solis', limit: null }])
  })

  it('issues a key with a daily cost cap and a concurrency cap, by the id Magpie gave it', async () => {
    const magpie = fakeMagpie()
    const answer = await new ShareKeys({ run: magpie.run }).issue({ device: 'Solis Core', dailyUsd: 15 })
    expect(answer).toMatchObject({ ok: true, shared: { name: expect.stringMatching(/^device-solis-core--[0-9a-f]{32}$/), device: 'solis-core' } })
    if (!answer.ok) throw new Error(answer.why)
    expect(answer.key).toMatch(/^sk-magpie-k+$/)
    const id = 'f'.repeat(24)
    expect(magpie.calls).toContainEqual(['gateway-key', 'add', answer.shared.name])
    expect(magpie.calls).toContainEqual(['gateway-key', 'limit', id, 'add', 'day', '--cost', '15'])
    expect(magpie.calls).toContainEqual(['gateway-key', 'concurrency', id, '8'])
  })

  it('never puts the key on a command line', async () => {
    const magpie = fakeMagpie()
    await new ShareKeys({ run: magpie.run }).issue({ device: 'solis', dailyUsd: 20 })
    expect(magpie.calls.flat().some((word) => word.startsWith('sk-magpie-'))).toBe(false)
  })

  it('takes the key back when a cap could not be set', async () => {
    const magpie = fakeMagpie({ failLimit: true })
    const answer = await new ShareKeys({ run: magpie.run }).issue({ device: 'solis', dailyUsd: 20 })
    expect(answer.ok).toBe(false)
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })

  it('refuses a device that already has a key, a bad cap, and an answer that is not a key', async () => {
    const magpie = fakeMagpie()
    magpie.rows.push({ id: 'a'.repeat(24), name: 'device-solis' })
    const keys = new ShareKeys({ run: magpie.run })
    expect(await keys.issue({ device: 'solis', dailyUsd: 20 })).toMatchObject({ ok: false })
    expect(await keys.issue({ device: 'laptop', dailyUsd: 0 })).toMatchObject({ ok: false })
    expect(await keys.issue({ device: 'laptop', dailyUsd: 5000 })).toMatchObject({ ok: false })
    expect(await keys.issue({ device: '', dailyUsd: 20 })).toMatchObject({ ok: false })
    expect(await new ShareKeys({ run: fakeMagpie({ key: 'Usage: …' }).run }).issue({ device: 'laptop', dailyUsd: 20 })).toMatchObject({ ok: false })
  })

  it('revokes the key of its own random name when Magpie does not return a key', async () => {
    const magpie = fakeMagpie({ key: 'sk-magpie-abcdefabcdefabcdefabcdef\nA newer magpie is out' })
    const answer = await new ShareKeys({ run: magpie.run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer.ok).toBe(false)
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })

  it.each([0, 1])('revokes every key of its own name when two appear after add exits %i', async (code) => {
    const magpie = fakeMagpie()
    const run: MagpieRun = async (args) => {
      const answer = await magpie.run(args)
      if (args[1] !== 'add') return answer
      magpie.rows.push({ id: 'b'.repeat(24), name: args[2] })
      return { ...answer, code }
    }
    const answer = await new ShareKeys({ run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer.ok).toBe(false)
    expect(magpie.calls.filter((args) => args[1] === 'remove').map((args) => args[2]).sort()).toEqual(['b'.repeat(24), 'f'.repeat(24)])
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })

  it('warns if add fails and a subsequent list cannot identify a potentially late key', async () => {
    const magpie = fakeMagpie()
    const run: MagpieRun = async (args) => {
      if (args[1] === 'add') return { code: 1, stdout: '', stderr: 'timed out' }
      return magpie.run(args)
    }
    const answer = await new ShareKeys({ run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer).toMatchObject({ ok: false, why: expect.stringContaining('timed out') })
  })

  it('never caps or delivers a different newly listed key when our returned key does not match', async () => {
    const magpie = fakeMagpie()
    const run: MagpieRun = async (args) => {
      const answer = await magpie.run(args)
      if (args[1] === 'add') return { ...answer, stdout: `sk-magpie-${'q'.repeat(52)}\n` }
      return answer
    }
    const answer = await new ShareKeys({ run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer.ok).toBe(false)
    expect(magpie.calls.filter((args) => ['limit', 'concurrency'].includes(args[1]))).toEqual([])
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })

  it('never deletes a key of another name when add fails', async () => {
    const magpie = fakeMagpie()
    const run: MagpieRun = async (args) => {
      if (args[1] === 'add') {
        magpie.rows.push({ id: 'b'.repeat(24), name: 'device-laptop' })
        return { code: 1, stdout: '', stderr: 'timed out' }
      }
      return magpie.run(args)
    }
    const answer = await new ShareKeys({ run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer).toMatchObject({ ok: false, why: expect.stringContaining('timed out') })
    expect(magpie.rows.some((row) => row.id === 'b'.repeat(24))).toBe(true)
    expect(magpie.calls.filter((args) => args[1] === 'remove')).toEqual([])
  })

  it('revokes the key of its own name if add throws', async () => {
    const magpie = fakeMagpie()
    const run: MagpieRun = async (args) => {
      const answer = await magpie.run(args)
      if (args[1] === 'add') throw new Error('runner failed after add')
      return answer
    }
    const answer = await new ShareKeys({ run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer.ok).toBe(false)
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })

  it('warns when both attempts to identify a possibly created key fail', async () => {
    const magpie = fakeMagpie()
    let lists = 0
    const run: MagpieRun = async (args) => {
      if (args[1] === 'list' && ++lists > 1) throw new Error('list unavailable')
      return magpie.run(args)
    }
    const answer = await new ShareKeys({ run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer).toMatchObject({ ok: false, why: expect.stringContaining('warning stays') })
  })

  it('warns if rollback cannot remove the newly created key', async () => {
    const magpie = fakeMagpie({ failLimit: true })
    const run: MagpieRun = async (args) => args[1] === 'remove'
      ? { code: 1, stdout: '', stderr: 'remove failed' }
      : magpie.run(args)
    const answer = await new ShareKeys({ run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer).toMatchObject({ ok: false, why: expect.stringContaining('could not be revoked') })
  })

  it('revokes the key of its own name when the list after add fails', async () => {
    const magpie = fakeMagpie({ failListAt: 2 })
    const answer = await new ShareKeys({ run: magpie.run }).issue({ device: 'laptop', dailyUsd: 20 })
    expect(answer).toMatchObject({ ok: false, why: expect.stringContaining('timed out') })
    expect(magpie.calls.some((c) => c[1] === 'limit')).toBe(false)
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })

  it('issues one key per device even when two presses race', async () => {
    const magpie = fakeMagpie({ slow: true })
    const keys = new ShareKeys({ run: magpie.run })
    const [a, b] = await Promise.all([keys.issue({ device: 'laptop', dailyUsd: 20 }), keys.issue({ device: 'laptop', dailyUsd: 20 })])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(magpie.rows.filter((r) => r.name.startsWith('device-laptop--'))).toHaveLength(1)
  })

  it('does not read a hand-made key with spaces in its name as a device key', () => {
    const table = 'ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS\nabc12345abc12345abc12345  device-a  b  enabled  sk-…1  -  all  all  full\n'
    expect(() => parseKeyTable(table)).toThrow('unreadable gateway key row')
  })

  it('revokes only a key it made', async () => {
    const magpie = fakeMagpie()
    magpie.rows.push({ id: 'a'.repeat(24), name: 'device-solis' })
    const keys = new ShareKeys({ run: magpie.run })
    expect(await keys.revoke('9ed61cf285e943f9a28bfb6a')).toMatchObject({ ok: false })
    expect(await keys.revoke('a'.repeat(24))).toMatchObject({ ok: true })
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })
})

describe('where another device reaches this Magpie', () => {
  it('knows Magpie listens only here until its network sharing is on', () => {
    expect(gatewayOnNetwork('127.0.0.1:3425')).toBe(false)
    expect(gatewayOnNetwork('localhost:3425')).toBe(false)
    expect(gatewayOnNetwork('0.0.0.0:3425')).toBe(true)
    expect(gatewayOnNetwork(':3425')).toBe(true)
    expect(gatewayOnNetwork('192.168.1.20:3425')).toBe(true)
    expect(gatewayOnNetwork(null)).toBe(false)
  })

  it('lists this computer’s LAN addresses as https and its tailnet ones as plain http, with the gateway’s port', () => {
    const interfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
      utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
      en9: [{ address: '8.8.8.8', family: 'IPv4', internal: false }]
    }
    expect(shareUrls(interfaces, 3425, { self: ['100.101.102.103'], peers: [] })).toEqual(['https://192.168.1.20:3425', 'http://100.101.102.103:3425'])
  })
})

describe('who may mint a key on the owner’s gateway', () => {
  const read = (file: string): string => readFileSync(path.join(__dirname, '../src', file), 'utf8')

  it('registers the share channels through ownerOnly and nowhere else', () => {
    expect(read('main/index.ts')).toContain('registerShareIpc((channel, handler) => ipcMain.handle(channel, ownerOnly(handler)), {\n    enabled: () => launchLive?.() ?? null,')
    expect(read('main/index.ts').match(/route:share-/g)).toBeNull()
  })

  it('gives no companion or relay route to them', () => {
    for (const file of ['main/mobile-api.ts', 'main/mobile-server.ts', 'shared/remote-machine-calls.ts']) {
      expect(read(file)).not.toMatch(/share-(issue|list|revoke)|ShareKeys|routeShare/)
    }
  })

  it('answers plainly when Magpie is not here', async () => {
    const handlers = shareHandlers({ keys: null })
    expect(await handlers.list()).toEqual({ ok: false, why: 'Magpie is not installed on this computer.' })
    expect(await handlers.issue({ device: 'laptop', dailyUsd: 20 })).toMatchObject({ ok: false })
    expect(await handlers.revoke('a'.repeat(24))).toMatchObject({ ok: false })
  })

  it('turns a Magpie that fails into a sentence, not a throw', async () => {
    const keys = new ShareKeys({ run: async () => ({ code: 1, stdout: '', stderr: '2026/11/16 10:00:00 plugin: host starts\nmagpie: gateway is locked\n' }) })
    expect(await shareHandlers({ keys, interfaces: () => ({}) }).list()).toEqual({ ok: false, why: 'gateway is locked' })
  })
})
