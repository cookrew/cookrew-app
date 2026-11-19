// KEY ACKNOWLEDGEMENT (Relay contract, after key recovery v1): an intent written
// before `gateway-key add` stays after the key is capped and handed over. It is
// settled only when the key's recipient has it for sure: the owner pressed Done
// for a key shown in this computer's window, or the computer a sealed key was
// sent to stored it and acknowledged it over its own device session. Until then
// it warns through crashes and broken streams; a revoke by id settles it once
// Magpie lists no key of its name.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShareKeys, type MagpieRun } from '../src/main/route/share-keys'
import { fileIntentStore, memoryIntentStore, type IntentStore, type ShareIntent } from '../src/main/route/share-intents'

const HEAD = 'ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS'
const KEY = `sk-magpie-key-${'k'.repeat(40)}abc123`
const NONCE = '0123456789abcdef0123456789abcdef'
const NAME = `device-laptop--${NONCE}`
const ID = '1'.padStart(24, 'f')

interface Row {
  id: string
  name: string
  tail: string
  access: string
}

function fakeMagpie(opts: { removeKeeps?: boolean; accessFails?: boolean; mcpFails?: boolean } = {}): { run: MagpieRun; calls: string[][]; rows: Row[]; hold(verb: string): () => void } {
  const rows: Row[] = [{ id: '9ed61cf285e943f9a28bfb6a', name: 'solis-compare', tail: '5102ac', access: 'full' }]
  const calls: string[][] = []
  const holds = new Map<string, Promise<void>>()
  let n = 0
  const run: MagpieRun = async (args) => {
    calls.push(args)
    const [, verb, a1] = args
    await holds.get(verb)
    if (verb === 'list') return { code: 0, stdout: `${HEAD}\n${rows.map((r) => `${r.id}  ${r.name}  enabled  sk-magpie-key-…${r.tail}  -  all  all  ${r.access}`).join('\n')}\n`, stderr: '' }
    if (verb === 'mcp' && opts.mcpFails) return { code: 1, stdout: '', stderr: 'magpie: busy' }
    if (verb === 'access') {
      if (opts.accessFails) return { code: 1, stdout: '', stderr: 'magpie: busy' }
      const row = rows.find((r) => r.id === a1)
      if (row) row.access = args[3]
      return { code: 0, stdout: '', stderr: '' }
    }
    if (verb === 'add') {
      n += 1
      rows.push({ id: String(n).padStart(24, 'f'), name: a1, tail: KEY.slice(-6), access: args.includes('--read-only') ? 'read-only' : 'full' })
      return { code: 0, stdout: `${KEY}\n`, stderr: '' }
    }
    if (verb === 'remove') {
      const at = rows.findIndex((r) => r.id === a1)
      if (at >= 0 && !opts.removeKeeps) rows.splice(at, 1)
      return { code: 0, stdout: 'Gateway key removed\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const hold = (verb: string): (() => void) => {
    let release: () => void = () => {}
    holds.set(verb, new Promise<void>((r) => (release = r)))
    return () => {
      holds.delete(verb)
      release()
    }
  }
  return { run, calls, rows, hold }
}

const keysWith = (run: MagpieRun, intents: IntentStore, extra: { beforeRevoke?: (id: string) => void; audit?: (line: string) => void | Promise<void> } = {}): ShareKeys =>
  new ShareKeys({ run, intents, nonce: () => NONCE, processes: async () => [], ...extra })

/** An intent store whose writes can be made to fail from a given moment. */
function flakyStore(): IntentStore & { failWrites: boolean } {
  const inner = memoryIntentStore()
  const store = {
    failWrites: false,
    read: () => inner.read(),
    write: (intents: readonly ShareIntent[]) => {
      if (store.failWrites) throw new Error('disk full')
      inner.write(intents)
    }
  }
  return store
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('a key shown in the owner’s window stays open until Done', () => {
  it('records the capped key’s id and where it went on its intent, and never the key', async () => {
    const intents = memoryIntentStore()
    const answer = await keysWith(fakeMagpie().run, intents).issue({ device: 'laptop', dailyUsd: 5 })
    expect(answer.ok).toBe(true)
    expect(intents.read()).toMatchObject([{ name: NAME, device: 'laptop', issued: { id: ID, via: 'window' } }])
    expect(JSON.stringify(intents.read())).not.toContain('sk-magpie')
  })

  it('shows the key on screen as the hand-over, not as a key left behind, and will not revoke-and-check it there', async () => {
    const magpie = fakeMagpie()
    const keys = keysWith(magpie.run, memoryIntentStore())
    await keys.issue({ device: 'laptop', dailyUsd: 5 })
    const listed = await keys.list()
    expect(listed.handover).toMatchObject({ id: ID, key: KEY })
    expect(listed.pending).toEqual([])
    expect(await keys.resolve(NAME)).toMatchObject({ ok: false, why: expect.stringContaining('on screen') })
    expect(magpie.rows.map((r) => r.name)).toContain(NAME)
  })

  it('Done forgets the key and settles its intent; a second Done changes nothing', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    const keys = keysWith(magpie.run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 })
    expect(await keys.done(ID)).toEqual({ ok: true })
    expect(intents.read()).toEqual([])
    const listed = await keys.list()
    expect(listed.handover).toBeNull()
    expect(listed.keys.map((k) => k.id)).toEqual([ID])
    expect(await keys.done(ID)).toEqual({ ok: true })
  })

  it('retains the handover when Done cannot be written, allowing a retry', async () => {
    const intents = flakyStore()
    const keys = keysWith(fakeMagpie().run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 })
    intents.failWrites = true
    expect(await keys.done(ID)).toMatchObject({ ok: false })
    const listed = await keys.list()
    expect(listed.handover).toMatchObject({ id: ID })
    expect(intents.read()).toMatchObject([{ name: NAME }])
    intents.failWrites = false
    expect(await keys.done(ID)).toEqual({ ok: true })
  })

  it('after a restart, the owner may still say a key was copied, by its id', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    await keysWith(magpie.run, intents).issue({ device: 'laptop', dailyUsd: 5 })
    const restarted = keysWith(magpie.run, intents)
    expect((await restarted.list()).pending).toHaveLength(1)
    expect(await restarted.done(ID)).toEqual({ ok: true })
    expect(intents.read()).toEqual([])
  })

  it('takes the key back when its issue cannot be written down', async () => {
    const magpie = fakeMagpie()
    const intents = flakyStore()
    const run: MagpieRun = async (args) => {
      // The caps are the last Magpie calls before the key is marked as issued.
      if (args[1] === 'concurrency') intents.failWrites = true
      return magpie.run(args)
    }
    const answer = await keysWith(run, intents).issue({ device: 'laptop', dailyUsd: 5 })
    expect(answer).toMatchObject({ ok: false })
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })

  it('refuses another key for a device whose last key waits to be confirmed, and says so', async () => {
    const magpie = fakeMagpie()
    const keys = keysWith(magpie.run, memoryIntentStore())
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    expect(await keys.issue({ device: 'laptop', dailyUsd: 5 })).toMatchObject({ ok: false, why: expect.stringContaining('confirmed') })
    expect(magpie.calls.filter((c) => c[1] === 'add')).toHaveLength(1)
  })
})

describe('a key sent to another computer stays open until that computer acknowledges it', () => {
  it('Done never settles it: only its recipient can', async () => {
    const intents = memoryIntentStore()
    const keys = keysWith(fakeMagpie().run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    expect(await keys.done(ID)).toMatchObject({ ok: false })
    expect(intents.read()).toMatchObject([{ name: NAME, issued: { id: ID, via: 'seal' } }])
  })

  it('an acknowledgement settles the intent of that id, and a repeated one is harmless', async () => {
    const intents = memoryIntentStore()
    const keys = keysWith(fakeMagpie().run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    expect(await keys.acknowledge(ID)).toEqual({ ok: true })
    expect(intents.read()).toEqual([])
    expect(await keys.acknowledge(ID)).toEqual({ ok: true })
  })

  it('a late acknowledgement after a restart still settles it', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    await keysWith(magpie.run, intents).issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    expect(await keysWith(magpie.run, intents).acknowledge(ID)).toEqual({ ok: true })
    expect(intents.read()).toEqual([])
  })

  it('refuses to acknowledge a key that was shown in this window, or an id that is not one', async () => {
    const intents = memoryIntentStore()
    const keys = keysWith(fakeMagpie().run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 })
    expect(await keys.acknowledge(ID)).toMatchObject({ ok: false })
    expect(await keys.acknowledge('../../x')).toMatchObject({ ok: false })
    expect(await keys.acknowledge(42)).toMatchObject({ ok: false })
    expect(intents.read()).toHaveLength(1)
  })

  it('says so when the acknowledgement cannot be written, and the intent stays', async () => {
    const intents = flakyStore()
    const keys = keysWith(fakeMagpie().run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    intents.failWrites = true
    expect(await keys.acknowledge(ID)).toMatchObject({ ok: false })
    expect(intents.read()).toHaveLength(1)
  })
})

describe('revoking an issued key by id', () => {
  it('unbinds it first, removes it, and settles its intent once Magpie lists none of its name', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    const unbound: string[] = []
    const keys = keysWith(magpie.run, intents, { beforeRevoke: (id) => unbound.push(id) })
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    expect(await keys.revoke(ID)).toEqual({ ok: true })
    expect(unbound).toEqual([ID])
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
    expect(intents.read()).toEqual([])
  })

  it('keeps warning when Magpie still lists a key of the name after the remove', async () => {
    const magpie = fakeMagpie({ removeKeeps: true })
    const intents = memoryIntentStore()
    const keys = keysWith(magpie.run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    await keys.revoke(ID)
    expect(intents.read()).toMatchObject([{ name: NAME, revoked: { left: 1 } }])
  })

  it('revoking the key on screen ends the hand-over and its warning together', async () => {
    const intents = memoryIntentStore()
    const keys = keysWith(fakeMagpie().run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 })
    expect(await keys.revoke(ID)).toEqual({ ok: true })
    expect((await keys.list()).handover).toBeNull()
    expect(intents.read()).toEqual([])
  })

  it('writes an audit line when it clears an intent by itself, naming the key by name and id only', async () => {
    const audit: string[] = []
    const keys = keysWith(fakeMagpie().run, memoryIntentStore(), { audit: (line) => void audit.push(line) })
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    await keys.revoke(ID)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toContain(NAME)
    expect(audit[0]).toContain(ID)
    expect(audit[0]).toMatch(/cleared/)
    expect(audit.join('\n')).not.toContain(KEY)
    expect(audit.join('\n')).not.toContain(KEY.slice(-6))
  })

  it('writes an audit line when it keeps the warning because Magpie still lists a key of the name', async () => {
    const audit: string[] = []
    const intents = memoryIntentStore()
    const keys = keysWith(fakeMagpie({ removeKeeps: true }).run, intents, { audit: (line) => void audit.push(line) })
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    await keys.revoke(ID)
    expect(intents.read()).toMatchObject([{ name: NAME, revoked: { left: 1 } }])
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatch(/kept/)
    expect(audit[0]).toContain(NAME)
    expect(audit.join('\n')).not.toContain(KEY)
  })

  it('never settles an intent whose add may still be running (one with no issued key)', async () => {
    const magpie = fakeMagpie()
    const left = `device-laptop--${'b'.repeat(32)}`
    magpie.rows.push({ id: 'c'.repeat(24), name: left, tail: 'aaaaaa', access: 'full' })
    const intents = memoryIntentStore([{ name: left, device: 'laptop', at: 'x' }])
    expect(await keysWith(magpie.run, intents).revoke('c'.repeat(24))).toEqual({ ok: true })
    expect(intents.read()).toMatchObject([{ name: left }])
  })
})

describe('one thing at a time', () => {
  it('acknowledge, Done and revoke wait behind a key being made', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    const keys = keysWith(magpie.run, intents)
    const release = magpie.hold('concurrency')
    const issuing = keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    for (let i = 0; i < 50 && !magpie.calls.some((c) => c[1] === 'concurrency'); i += 1) await tick(2)
    const settled: string[] = []
    const acking = keys.acknowledge(ID).then((a) => (settled.push('ack'), a))
    const revoking = keys.revoke(ID).then((a) => (settled.push('revoke'), a))
    await tick(20)
    expect(settled).toEqual([])
    expect(magpie.calls.some((c) => c[1] === 'remove')).toBe(false)
    release()
    expect((await issuing).ok).toBe(true)
    // In turn: the acknowledgement lands on the issued intent, then the revoke takes the key.
    expect(await acking).toEqual({ ok: true })
    expect(await revoking).toEqual({ ok: true })
    expect(settled).toEqual(['ack', 'revoke'])
    expect(intents.read()).toEqual([])
  })
})

describe('the intent file with an issued key', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'share-ack-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the id and where the key went across a new store, and never the key', () => {
    const file = path.join(dir, 'share-intents.json')
    const intent: ShareIntent = { name: NAME, device: 'laptop', at: 'x', issued: { at: 'y', id: ID, via: 'seal' } }
    fileIntentStore(file).write([intent])
    expect(fileIntentStore(file).read()).toEqual([intent])
    expect(readFileSync(file, 'utf8')).not.toContain('sk-magpie')
  })

  it.each([
    ['an unknown destination', { at: 'y', id: ID, via: 'email' }],
    ['an id Magpie would never give', { at: 'y', id: '../x', via: 'seal' }],
    ['no time', { id: ID, via: 'window' }]
  ])('refuses a record whose issued key has %s', (_why, issued) => {
    const file = path.join(dir, 'share-intents.json')
    writeFileSync(file, JSON.stringify({ v: 1, intents: [{ name: NAME, device: 'laptop', at: 'x', issued }] }))
    expect(() => fileIntentStore(file).read()).toThrow()
  })
})

describe('review H1: a key works in Magpie itself only once it has arrived', () => {
  it.each([
    ['window', undefined],
    ['seal', { handover: false }]
  ] as const)('a %s key is made read-only, and stays so until it is confirmed', async (_via, options) => {
    const magpie = fakeMagpie()
    const keys = keysWith(magpie.run, memoryIntentStore())
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, options)
    expect(magpie.calls.find((c) => c[1] === 'add')).toEqual(['gateway-key', 'add', NAME, '--read-only'])
    expect(magpie.rows.find((r) => r.id === ID)?.access).toBe('read-only')
  })

  it('Done turns the key on in Magpie before it clears the record', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    let atAccess: readonly unknown[] = []
    const run: MagpieRun = async (args) => {
      if (args[1] === 'access') atAccess = intents.read()
      return magpie.run(args)
    }
    const keys = keysWith(run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 })
    expect(await keys.done(ID)).toEqual({ ok: true })
    expect(magpie.calls).toContainEqual(['gateway-key', 'access', ID, 'full'])
    expect(atAccess).toHaveLength(1)
    expect(magpie.rows.find((r) => r.id === ID)?.access).toBe('full')
    expect(intents.read()).toEqual([])
  })

  it('acknowledging a sealed key turns it on in Magpie before it clears the record', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    const keys = keysWith(magpie.run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    expect(await keys.acknowledge(ID)).toEqual({ ok: true })
    expect(magpie.rows.find((r) => r.id === ID)?.access).toBe('full')
    expect(intents.read()).toEqual([])
  })

  it('when Magpie will not turn it on, Done and acknowledge fail and the record and the key on screen stay', async () => {
    const magpie = fakeMagpie({ accessFails: true })
    const intents = memoryIntentStore()
    const keys = keysWith(magpie.run, intents)
    await keys.issue({ device: 'laptop', dailyUsd: 5 })
    expect(await keys.done(ID)).toMatchObject({ ok: false })
    expect((await keys.list()).handover).toMatchObject({ id: ID })
    expect(intents.read()).toHaveLength(1)
    expect(magpie.rows.find((r) => r.id === ID)?.access).toBe('read-only')
  })

  it('takes back a key Magpie did not make read-only', async () => {
    const magpie = fakeMagpie()
    const run: MagpieRun = async (args) => magpie.run(args[1] === 'add' ? args.filter((a) => a !== '--read-only') : args)
    const intents = memoryIntentStore()
    expect(await keysWith(run, intents).issue({ device: 'laptop', dailyUsd: 5 })).toMatchObject({ ok: false })
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
  })
})

describe('a device key reaches models only, never this computer’s MCP servers', () => {
  it('shuts every MCP server off for the key before it leaves (Magpie lets a new key use them all)', async () => {
    const magpie = fakeMagpie()
    const keys = keysWith(magpie.run, memoryIntentStore())
    expect(await keys.issue({ device: 'laptop', dailyUsd: 5 })).toMatchObject({ ok: true })
    expect(magpie.calls).toContainEqual(['gateway-key', 'mcp', ID, 'none'])
  })

  it('takes the key back when Magpie will not shut them off', async () => {
    const magpie = fakeMagpie({ mcpFails: true })
    const intents = memoryIntentStore()
    expect(await keysWith(magpie.run, intents).issue({ device: 'laptop', dailyUsd: 5 })).toMatchObject({ ok: false })
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
    expect(intents.read()).toMatchObject([{ name: NAME, revoked: { left: 0 } }])
  })
})

describe('verification review: a confirmation is audited, before its record goes', () => {
  it.each([
    ['window', undefined, (keys: ShareKeys) => keys.done(ID)],
    ['seal', { handover: false }, (keys: ShareKeys) => keys.acknowledge(ID)]
  ] as const)('a %s key turned on writes an audit line while its record is still there', async (_via, options, confirm) => {
    const intents = memoryIntentStore()
    const audit: Array<{ line: string; open: number }> = []
    const keys = keysWith(fakeMagpie().run, intents, { audit: (line) => void audit.push({ line, open: intents.read().length }) })
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, options)
    expect(await confirm(keys)).toEqual({ ok: true })
    const turnedOn = audit.filter((a) => /turned on/.test(a.line))
    expect(turnedOn).toHaveLength(1)
    expect(turnedOn[0].line).toContain(ID)
    expect(turnedOn[0].line).toContain(NAME)
    expect(turnedOn[0].open).toBe(1)
    expect(audit.map((a) => a.line).join('\n')).not.toContain(KEY)
    // Nor its last six characters, which Magpie shows and which narrow a key down (relay verification L4).
    expect(audit.map((a) => a.line).join('\n')).not.toContain(KEY.slice(-6))
  })

  it('the revoke that clears a record writes its line while the record is still there', async () => {
    const intents = memoryIntentStore()
    const audit: Array<{ line: string; open: number }> = []
    const keys = keysWith(fakeMagpie().run, intents, { audit: (line) => void audit.push({ line, open: intents.read().length }) })
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, { handover: false })
    await keys.revoke(ID)
    expect(audit.find((a) => /cleared/.test(a.line))?.open).toBe(1)
    expect(intents.read()).toEqual([])
  })
})

describe('relay review of eb001d27: an audit line is on disk BEFORE its record is cleared', () => {
  /** An audit whose writes are held until the test lets them go. */
  const heldAudit = () => {
    const pending: Array<() => void> = []
    return {
      audit: (_line: string) => new Promise<void>((resolve) => void pending.push(resolve)),
      release: () => pending.splice(0).forEach((go) => go()),
      waiting: () => pending.length
    }
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  }

  it.each([
    ['Done', undefined, (keys: ShareKeys) => keys.done(ID)],
    ['acknowledge', { handover: false }, (keys: ShareKeys) => keys.acknowledge(ID)],
    ['a revoke that clears', { handover: false }, (keys: ShareKeys) => keys.revoke(ID)]
  ] as const)('%s waits for the audit write before the intent goes', async (_what, options, act) => {
    const intents = memoryIntentStore()
    const held = heldAudit()
    const keys = keysWith(fakeMagpie().run, intents, { audit: held.audit })
    await keys.issue({ device: 'laptop', dailyUsd: 5 }, () => true, options)
    let finished = false
    const doing = act(keys).then((a) => ((finished = true), a))
    await settle()
    for (let i = 0; i < 50 && held.waiting() === 0; i += 1) await new Promise((r) => setTimeout(r, 2))
    expect(held.waiting()).toBe(1)
    // The audit has not landed: the record must still be there, and the call not answered.
    expect(intents.read()).toHaveLength(1)
    expect(finished).toBe(false)
    held.release()
    expect(await doing).toEqual({ ok: true })
    expect(intents.read()).toEqual([])
  })

  it('a failed audit write is reported elsewhere by its writer and never fails the caller (as before)', async () => {
    const intents = memoryIntentStore()
    const keys = keysWith(fakeMagpie().run, intents, { audit: async () => undefined })
    await keys.issue({ device: 'laptop', dailyUsd: 5 })
    expect(await keys.done(ID)).toEqual({ ok: true })
  })
})
