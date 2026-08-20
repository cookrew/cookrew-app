import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PinStore, isTerminalId } from '../src/main/pin-store'
import { pinAnchors, type VersionPinRecord } from '../src/shared/version-pin'

const ID = 'db9b45d0-1793-4ca3-904a-696374e6446a'
const OTHER = '60582384-8d5e-4bf1-83a3-ecfb656ed8e6'

const pin = (version: number, atIndex: number): VersionPinRecord => ({
  version,
  atIndex,
  scrollLine: atIndex * 10,
  cutAt: 1_700_000_000_000
})

let base = ''
let store: PinStore
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-pins-'))
  store = new PinStore(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('PinStore — §10 becomes answerable at runtime', () => {
  it('records a pin and reads it back', () => {
    store.add(ID, pin(1, 4))
    expect(store.list(ID)).toEqual([pin(1, 4)])
  })

  it('survives a reopen — a pin outlives the process that cut it', () => {
    store.add(ID, pin(1, 4))
    expect(new PinStore(base).list(ID)).toEqual([pin(1, 4)])
  })

  it('keeps pins per terminal, because a pin belongs to a transcript', () => {
    store.add(ID, pin(1, 4))
    store.add(OTHER, pin(1, 9))
    expect(store.list(ID)).toEqual([pin(1, 4)])
    expect(store.list(OTHER)).toEqual([pin(1, 9)])
  })

  it('returns pins ordered by version whatever order they arrived in', () => {
    store.add(ID, pin(2, 8))
    store.add(ID, pin(1, 4))
    expect(store.list(ID).map((p) => p.version)).toEqual([1, 2])
  })

  it('is idempotent by version, so a retried install cannot duplicate a pin', () => {
    store.add(ID, pin(1, 4))
    store.add(ID, pin(1, 4))
    store.add(ID, { ...pin(1, 4), cutAt: 999 })
    expect(store.list(ID)).toHaveLength(1)
  })

  it('reports the next version to cut', () => {
    expect(store.next(ID)).toBe(1)
    store.add(ID, pin(1, 4))
    store.add(ID, pin(3, 9))
    // Past the highest, never the count — a deleted pin must not alias.
    expect(store.next(ID)).toBe(4)
  })

  it('is empty for a terminal that has none', () => {
    expect(store.list(ID)).toEqual([])
  })
})

describe('PinStore — a renderer value becomes a path only after it is proven', () => {
  const HOSTILE = ['../../../etc/passwd', '..', '', 'not-a-uuid', `${ID}/../../x`]

  it('rejects every non-id shape', () => {
    for (const value of HOSTILE) expect(isTerminalId(value)).toBe(false)
  })

  it('reads nothing for a traversing id', () => {
    const outside = path.join(base, 'secret.json')
    writeFileSync(outside, '[{"version":9}]')
    for (const value of HOSTILE) expect(store.list(value)).toEqual([])
  })

  it('refuses to WRITE against a traversing id rather than failing quietly', () => {
    for (const value of HOSTILE) expect(() => store.add(value, pin(1, 1))).toThrow()
  })
})

describe('PinStore — a bad file degrades to no pins, never to wrong ones', () => {
  it('drops a malformed record instead of placing it somewhere', () => {
    mkdirSync(path.join(base, 'pins'), { recursive: true })
    writeFileSync(
      path.join(base, 'pins', `${ID}.json`),
      JSON.stringify([pin(1, 4), { version: 'two' }, { atIndex: 3 }])
    )
    // A pin the rail cannot place correctly is a wrong version, and R8 says a
    // wrong version is worse than an absent one.
    expect(store.list(ID)).toEqual([pin(1, 4)])
  })

  it('returns nothing for unreadable JSON', () => {
    mkdirSync(path.join(base, 'pins'), { recursive: true })
    writeFileSync(path.join(base, 'pins', `${ID}.json`), 'not json')
    expect(store.list(ID)).toEqual([])
  })

  it('writes nothing until there is a pin to write', () => {
    expect(existsSync(path.join(base, 'pins', `${ID}.json`))).toBe(false)
  })
})

describe('PinStore — what it hands the rail is directly renderable', () => {
  it('feeds pinAnchors, which places only pins whose checkpoint is drawn', () => {
    store.add(ID, pin(1, 2))
    store.add(ID, pin(2, 99)) // a checkpoint this ledger does not have
    const rows = [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }]
    expect(pinAnchors(store.list(ID), rows)).toEqual([{ version: 1, frac: 0.25 }])
  })

  it('an install pinned before the first turn draws nothing yet', () => {
    // planPresetImport pins a fresh install at atIndex 0 — no drawn row, so
    // the rail correctly shows nothing until the buyer's session has one.
    store.add(ID, pin(1, 0))
    expect(pinAnchors(store.list(ID), [{ index: 1 }, { index: 2 }])).toEqual([])
  })
})
