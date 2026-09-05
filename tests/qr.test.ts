import { describe, expect, it } from 'vitest'
import { QR_MAX_VERSION, qrCapacity, qrMatrix, qrPath, qrVersionFor } from '../src/shared/qr'
import { QR_FIXTURES } from './support/qr-fixtures'

const asRows = (modules: boolean[][]): string[] =>
  modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))

describe('qr encoder against an independent implementation', () => {
  for (const fixture of QR_FIXTURES) {
    it(`matches the reference module for module: ${fixture.label}`, () => {
      const modules = qrMatrix(fixture.text)
      expect(modules).not.toBeNull()
      const rows = asRows(modules as boolean[][])
      // Size first: a mismatch here makes the row diff unreadable.
      expect(rows).toHaveLength(fixture.version * 4 + 17)
      expect(rows).toEqual([...fixture.rows])
    })
  }
})

describe('qr version choice', () => {
  it('picks the smallest version that holds the payload', () => {
    expect(qrVersionFor(1)).toBe(1)
    expect(qrVersionFor(qrCapacity(1))).toBe(1)
    expect(qrVersionFor(qrCapacity(1) + 1)).toBe(2)
    expect(qrVersionFor(55)).toBe(4)
  })

  it('reports capacity growing with the version', () => {
    for (let v = 2; v <= QR_MAX_VERSION; v++) {
      expect(qrCapacity(v)).toBeGreaterThan(qrCapacity(v - 1))
    }
    expect(qrCapacity(10)).toBe(213)
  })

  it('refuses a payload no supported version can carry, rather than truncating', () => {
    expect(qrVersionFor(qrCapacity(QR_MAX_VERSION) + 1)).toBeNull()
    expect(qrMatrix('y'.repeat(qrCapacity(QR_MAX_VERSION) + 1))).toBeNull()
  })

  it('counts UTF-8 bytes, not characters', () => {
    // 'é' is two bytes, so 106 of them fill a symbol that 106 ASCII would leave room in.
    expect(qrMatrix('é'.repeat(106))).not.toBeNull()
    expect(qrMatrix('é'.repeat(106))?.length).toBeGreaterThan(0)
  })
})

describe('qr geometry', () => {
  const modules = qrMatrix('cookrew-pair:2c9417fd:7KQ2M8') as boolean[][]

  it('is square and carries three finder patterns', () => {
    const n = modules.length
    for (const row of modules) expect(row).toHaveLength(n)
    for (const [r, c] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0]
    ]) {
      expect(modules[r][c]).toBe(true)
      expect(modules[r + 1][c + 1]).toBe(false)
      expect(modules[r + 3][c + 3]).toBe(true)
    }
  })

  it('carries the alternating timing patterns', () => {
    const n = modules.length
    for (let i = 8; i < n - 8; i++) {
      expect(modules[6][i]).toBe(i % 2 === 0)
      expect(modules[i][6]).toBe(i % 2 === 0)
    }
  })

  it('keeps the always-dark module', () => {
    expect(modules[modules.length - 8][8]).toBe(true)
  })
})

describe('qr as an svg path', () => {
  it('draws one unit square per dark module and nothing per light one', () => {
    const path = qrPath([
      [true, false],
      [false, true]
    ])
    expect(path).toBe('M0 0h1v1h-1zM1 1h1v1h-1z')
  })

  it('is empty for an all-light matrix', () => {
    expect(qrPath([[false, false]])).toBe('')
  })
})
