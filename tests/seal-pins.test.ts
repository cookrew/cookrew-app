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
})
