import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { answerPeer, askForKey, desktopsWithoutBlocked, forgetBlocked, keysWithoutBlocked, marksWithBlocked, type PeerAnswerDeps } from '../src/main/seal-blocked'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import { createMachineKeyStore, createRefusedMachines } from '../src/main/machine-keys'
import { tempBase } from './support/idv2'
import { createSealMarks } from '../src/main/seal-marks'
import { createSealPinStore } from '../src/main/seal-pins'

const dirs: string[] = []
const fileIn = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-blocked-'))
  dirs.push(dir)
  return path.join(dir, name)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const A = '48e5b104-a62d-8f13-a322-2b66aee4dbeb'
const B = '53ab5b71-1430-891d-a7ce-2e3d6f3856bc'

/** The real pin store, and every other way in as a record of what was ended. */
function answering(admissionGoes = true) {
  const pins = createSealPinStore(fileIn('seal-pins.json'))
  const ended: string[] = []
  const deps: PeerAnswerDeps = {
    pins,
    peers: { closePeer: (id) => void ended.push(`dialled:${id}`) },
    terminus: { endPeer: (id) => void ended.push(`let-in:${id}`) },
    forgetAdmission: (id) => (ended.push(`admission:${id}`), admissionGoes),
    forgetKey: (id) => void ended.push(`key:${id}`),
    refuseMachine: (id) => void ended.push(`forgotten:${id}`)
  }
  pins.contact(A)
  return { pins, ended, deps }
}

describe('the owner answers another desktop\'s six words (index.ts seal:peer-answer)', () => {
  it('same pins it and ends nothing', () => {
    const { pins, ended, deps } = answering()
    expect(answerPeer(A, 'same', deps)).toBe(true)
    expect(pins.pinned()).toEqual([A])
    expect(pins.waiting()).toEqual([])
    expect(ended).toEqual([])
  })

  it('later only puts the question off: nothing pinned, nothing blocked, nothing ended', () => {
    const { pins, ended, deps } = answering()
    pins.setPolicy('pinned')
    expect(answerPeer(A, 'later', deps)).toBe(true)
    expect(pins.pinned()).toEqual([])
    expect(pins.blocks(A)).toBe(false)
    // Pinned policy: a desktop put off is not let in, as one never compared is not.
    expect(pins.allows(A)).toBe(false)
    expect(pins.waiting()).toEqual([])
    expect(ended).toEqual([])
  })

  it('not the same blocks it and ends every way it is in: sealed both ways, its admission here, the key held for it', () => {
    const { pins, ended, deps } = answering()
    pins.pin(B)
    expect(answerPeer(A, 'not-same', deps)).toBe(true)
    expect(pins.blocks(A)).toBe(true)
    expect(pins.allows(A)).toBe(false)
    expect(ended).toEqual([`dialled:${A}`, `let-in:${A}`, `admission:${A}`, `key:${A}`, `forgotten:${A}`])
    // Only that desktop.
    expect(pins.blocks(B)).toBe(false)
    expect(pins.pinned()).toEqual([B])
  })

  it('not the same whose admission could not be dropped answers false, and the block stands', () => {
    const { pins, ended, deps } = answering(false)
    expect(answerPeer(A, 'not-same', deps)).toBe(false)
    expect(pins.blocks(A)).toBe(true)
    expect(ended).toContain(`admission:${A}`)
  })

  it('a write that throws keeps none of the others from happening, and answers false', () => {
    const { pins, ended, deps } = answering()
    const failing: PeerAnswerDeps = {
      ...deps,
      forgetAdmission: () => {
        throw new Error('disk full')
      },
      refuseMachine: (id) => {
        ended.push(`forgotten:${id}`)
        throw new Error('disk full')
      }
    }
    expect(answerPeer(A, 'not-same', failing)).toBe(false)
    expect(pins.blocks(A)).toBe(true)
    expect(ended).toEqual([`dialled:${A}`, `let-in:${A}`, `key:${A}`, `forgotten:${A}`])
    const sweep = forgetBlocked(pins, { forgetAdmission: failing.forgetAdmission, forgetKey: (id) => void ended.push(`swept-key:${id}`) })
    expect(sweep).toEqual([A])
    expect(ended.at(-1)).toBe(`swept-key:${A}`)
  })

  it('with the real stores: the token a blocked desktop was admitted with opens nothing, and it stays a forgotten machine', () => {
    const temp = tempBase()
    try {
      const admitted = createAdmittedDeviceStore({ base: temp.base })
      const forgotten = createRefusedMachines(fileIn('machine-refused.json'))
      const keys = createMachineKeyStore(fileIn('machine-keys.json'))
      const pins = createSealPinStore(fileIn('seal-pins.json'))
      const { token } = admitted.admit({ deviceId: A, name: 'not mine', via: 'machine' })
      const other = admitted.admit({ deviceId: B, name: 'mine', via: 'machine' })
      keys.keep(A, 'not mine', 'key-for-a')
      expect(admitted.deviceFor(token)).toBe(A)
      const deps: PeerAnswerDeps = {
        pins,
        peers: { closePeer: () => undefined },
        terminus: { endPeer: () => undefined },
        forgetAdmission: admitted.forget,
        forgetKey: (id) => keys.forget([id]),
        refuseMachine: forgotten.add
      }
      expect(answerPeer(A, 'not-same', deps)).toBe(true)
      expect(admitted.deviceFor(token)).toBeNull()
      expect(admitted.deviceFor(other.token)).toBe(B)
      expect(keys.token(A)).toBeNull()
      expect(forgotten.has(A)).toBe(true)
      expect(forgotten.has(B)).toBe(false)
    } finally {
      temp.clean()
    }
  })

  it('answers false and does nothing for a malformed id or an answer it does not know', () => {
    const { pins, ended, deps } = answering()
    for (const [id, answer] of [
      [A, 'maybe'],
      [A, undefined],
      ['not-an-id', 'not-same'],
      [A.toUpperCase(), 'not-same'],
      [42, 'same']
    ] as const) {
      expect(answerPeer(id, answer, deps)).toBe(false)
    }
    expect(pins.pinned()).toEqual([])
    expect(pins.blocks(A)).toBe(false)
    expect(ended).toEqual([])
  })
})

describe('a blocked desktop on the lanes that are not sealed (Relay round 4, A)', () => {
  it('at launch, an admission and a key a blocked desktop still holds (blocked on an older build) go', () => {
    const pins = createSealPinStore(fileIn('seal-pins.json'))
    const gone: string[] = []
    expect(forgetBlocked(pins, { forgetAdmission: (id) => (gone.push(`admission:${id}`), true), forgetKey: (id) => void gone.push(`key:${id}`) })).toEqual([])
    pins.block(A)
    expect(forgetBlocked(pins, { forgetAdmission: (id) => (gone.push(`admission:${id}`), true), forgetKey: (id) => void gone.push(`key:${id}`) })).toEqual([A])
    expect(gone).toEqual([`admission:${A}`, `key:${A}`])
  })

  it('a machine with no key is asked for in a round, unless it is blocked: no round would ever bring one', () => {
    const pins = createSealPinStore(fileIn('seal-pins.json'))
    let rounds = 0
    const ask = askForKey(pins, () => void (rounds += 1))
    ask(A)
    expect(rounds).toBe(1)
    pins.block(A)
    ask(A)
    ask(A.toUpperCase())
    expect(rounds).toBe(1)
    ask(B)
    expect(rounds).toBe(2)
  })

  it('the relay line refuses its plain requests; a desktop not blocked, and no device at all, are as the marks say', () => {
    const pins = createSealPinStore(fileIn('seal-pins.json'))
    const marks = createSealMarks(fileIn('seal-marks.json'))
    const line = marksWithBlocked(marks, pins)
    expect(line.refuses(A)).toBe(false)
    pins.block(A)
    expect(line.refuses(A)).toBe(true)
    expect(line.refuses(B)).toBe(false)
    expect(line.refuses(null)).toBe(false)
    // The rest is the marks' own.
    line.mark(B)
    expect(line.refuses(B)).toBe(true)
    line.setSealedOnly(true)
    expect(line.refuses(null)).toBe(true)
    expect(marks.sealedOnly()).toBe(true)
  })

  it('this desktop uses no key for it, keeps none for it, and sends it no pass to enter with', () => {
    const pins = createSealPinStore(fileIn('seal-pins.json'))
    const store = createMachineKeyStore(fileIn('machine-keys.json'))
    store.keep(A, 'blocked one', 'key-for-a')
    store.keep(B, 'other one', 'key-for-b')
    const keys = keysWithoutBlocked(store, pins)
    expect(keys.token(A)).toBe('key-for-a')
    pins.block(A)
    expect(keys.token(A)).toBeNull()
    expect(keys.token(B)).toBe('key-for-b')
    keys.keep(A, 'blocked one', 'a-new-key')
    expect(store.token(A)).toBe('key-for-a')
    keys.keep(B, 'other one', 'b-new-key')
    expect(store.token(B)).toBe('b-new-key')
    const rows = [
      { id: A, name: 'blocked one', online: true },
      { id: B, name: 'other one', online: true }
    ]
    expect(desktopsWithoutBlocked(rows, pins)).toEqual([rows[1]])
    expect(desktopsWithoutBlocked(null, pins)).toBeNull()
  })
})
