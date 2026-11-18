import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSealPinStore } from '../src/main/seal-pins'

const dirs: string[] = []
const fileIn = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-pins-'))
  dirs.push(dir)
  return path.join(dir, 'seal-pins.json')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const A = '48e5b104-a62d-8f13-a322-2b66aee4dbeb'
const B = '53ab5b71-1430-891d-a7ce-2e3d6f3856bc'

describe('seal pins', () => {
  it('trusts the account listing until the owner chooses pinned', () => {
    const pins = createSealPinStore(fileIn())
    expect(pins.policy()).toBe('account')
    expect(pins.allows(A)).toBe(true)
    pins.setPolicy('pinned')
    expect(pins.allows(A)).toBe(false)
    pins.pin(A)
    expect(pins.allows(A)).toBe(true)
    expect(pins.allows(A.toUpperCase())).toBe(true)
    expect(pins.allows(B)).toBe(false)
    pins.unpin(A)
    expect(pins.allows(A)).toBe(false)
  })

  it('a file it cannot read fails closed: pinned, with nothing pinned', () => {
    const file = fileIn()
    writeFileSync(file, '{ not json')
    expect(createSealPinStore(file).allows(A)).toBe(false)
    writeFileSync(file, JSON.stringify({ policy: 'something-else', pins: {} }))
    expect(createSealPinStore(file).allows(A)).toBe(false)
  })

  it('refuses what is not a device id, and drops one from the file', () => {
    const file = fileIn()
    const pins = createSealPinStore(file)
    expect(() => pins.pin('../../etc')).toThrow()
    writeFileSync(file, JSON.stringify({ policy: 'pinned', pins: { 'not-an-id': { at: 1 }, [A]: { at: 1 } } }))
    expect(pins.pinned()).toEqual([A])
  })

  it('first contact waits for the owner\'s words; same pins, not the same blocks both ways, later waits for the next launch', () => {
    const file = fileIn()
    const pins = createSealPinStore(file)
    expect(pins.contact(A)).toBe(true)
    expect(pins.contact(A)).toBe(false)
    expect(pins.waiting()).toEqual([A])
    pins.later(A)
    expect(pins.waiting()).toEqual([])
    expect(createSealPinStore(file).waiting()).toEqual([A])
    pins.pin(A)
    expect(createSealPinStore(file).waiting()).toEqual([])
    expect(pins.contact(A)).toBe(false)
    pins.contact(B)
    pins.block(B)
    expect(pins.allows(B)).toBe(false)
    expect(pins.waiting()).toEqual([])
    // The account policy still lets in a desktop never compared; a blocked one never.
    expect(pins.allows('0f0e0d0c-0b0a-4908-8706-050403020100')).toBe(true)
    pins.pin(B)
    expect(pins.allows(B)).toBe(true)
  })
})

