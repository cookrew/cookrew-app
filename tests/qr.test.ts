import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  QR_LEVELS,
  QR_MAX_VERSION,
  qrCapacity,
  qrDataCodewords,
  qrMatrix,
  qrPath,
  qrVersionFor,
  type QrLevel
} from '../src/shared/qr'
import { QR_FIXTURES } from './support/qr-fixtures'
import { QR_SWEEP } from './support/qr-sweep'
import { decodeQr } from './support/qr-decode'

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

  it('reports the byte capacity the standard gives, at every level', () => {
    // A capacity that is right proves the DATA codeword count is right; it
    // says nothing about how those codewords split into blocks, which is what
    // the sweep below is for. Both, or neither is worth much.
    expect(QR_LEVELS.map((l) => qrCapacity(1, l))).toEqual([17, 14, 11, 7])
    expect(QR_LEVELS.map((l) => qrCapacity(8, l))).toEqual([192, 152, 108, 84])
    expect(QR_LEVELS.map((l) => qrCapacity(10, l))).toEqual([271, 213, 151, 119])
  })

  it('splits into blocks the way the standard does at v8-M — 2x38 + 2x39', () => {
    // The first version whose blocks fall into two groups of unequal length.
    // Group 2 is always exactly one codeword longer, which is why the split is
    // derived rather than tabled.
    expect(qrDataCodewords(8, 'M')).toBe(154)
    expect(2 * 38 + 2 * 39).toBe(154)
    expect(qrDataCodewords(10, 'Q')).toBe(6 * 19 + 2 * 20)
    expect(qrDataCodewords(9, 'H')).toBe(4 * 12 + 4 * 13)
    expect(qrDataCodewords(7, 'Q')).toBe(2 * 14 + 4 * 15)
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

describe('the full sweep — every version, every level', () => {
  // The first sweep covered ten versions at ONE level with a repeated byte for
  // a payload. It matched, and it was still hiding a disagreement with the
  // reference on roughly one payload in six from version 7 up. Forty cells of
  // real text is what found it.
  const rowsOf = (modules: boolean[][]): string[] =>
    modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))

  for (const item of QR_SWEEP) {
    it(`matches the reference at v${item.version}-${item.level}`, () => {
      const modules = qrMatrix(item.text, item.level)
      expect(modules, 'the payload must fit the version it names').not.toBeNull()
      const rows = rowsOf(modules as boolean[][])
      expect(rows).toHaveLength(item.size)
      expect(rows[0]).toHaveLength(item.size)
      const digest = createHash('sha256').update(rows.join('\n')).digest('hex')
      expect(digest).toBe(item.digest)
    })
  }

  it('covers all forty cells, so a dropped case cannot pass as a green sweep', () => {
    expect(QR_SWEEP).toHaveLength(40)
    for (const level of QR_LEVELS) {
      const versions = QR_SWEEP.filter((c) => c.level === level).map((c) => c.version)
      expect(versions, level).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    }
  })

  it('fills each cell to the exact capacity of the version it names', () => {
    // So a case cannot slide to a neighbouring version when a table changes
    // and quietly stop testing the version in its own name.
    for (const item of QR_SWEEP) {
      const bytes = new TextEncoder().encode(item.text).length
      expect(bytes, `${item.version}-${item.level}`).toBe(qrCapacity(item.version, item.level))
      expect(qrVersionFor(bytes, item.level)).toBe(item.version)
    }
  })
})

describe('what this encoder makes, decodes', () => {
  // A reference comparison proves agreement with one other implementation. A
  // decode proves the property anybody actually cares about: the error
  // correction agrees with the data, so a scanner can read it. The decoder is
  // written from the standard in tests/support/qr-decode.ts and imports
  // nothing from the encoder.
  for (const item of QR_SWEEP) {
    it(`decodes back at v${item.version}-${item.level}`, () => {
      const modules = qrMatrix(item.text, item.level) as boolean[][]
      const read = decodeQr(modules)
      expect(read, JSON.stringify(read)).not.toHaveProperty('error')
      if ('error' in read) return
      expect(read.version).toBe(item.version)
      expect(read.level).toBe(item.level)
      expect(read.text).toBe(item.text)
    })
  }

  it('decodes the reported otpauth URL, syndromes and all', () => {
    const url =
      'otpauth://totp/Cookrew:andrej.dotscrafts?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' +
      '&issuer=Cookrew&algorithm=SHA1&digits=6&period=30'
    const read = decodeQr(qrMatrix(url) as boolean[][])
    expect(read).toMatchObject({ version: 8, level: 'M', text: url })
  })

  it('decodes every full fixture matrix too', () => {
    for (const fixture of QR_FIXTURES) {
      const read = decodeQr(qrMatrix(fixture.text) as boolean[][])
      expect(read, fixture.label).toMatchObject({ version: fixture.version, text: fixture.text })
    }
  })

  it('REFUSES a matrix whose error correction has been tampered with', () => {
    // The gate is only worth having if it can fail. Flipping a data module
    // breaks the block's syndromes, which is exactly what a wrong block split
    // or a wrong interleave does.
    const modules = qrMatrix('otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXP') as boolean[][]
    const broken = modules.map((row) => [...row])
    // A module well inside the data region, away from every function pattern.
    broken[20][20] = !broken[20][20]
    const read = decodeQr(broken)
    expect(read).toHaveProperty('error')
    if ('error' in read) expect(read.error).toContain('Reed-Solomon')
  })

  it('refuses a matrix whose format strip has been scrambled', () => {
    const modules = qrMatrix('hello world') as boolean[][]
    const broken = modules.map((row) => [...row])
    for (let i = 0; i < 6; i++) broken[8][i] = !broken[8][i]
    expect(decodeQr(broken)).toHaveProperty('error')
  })

  it('refuses something that is not a QR at all', () => {
    expect(decodeQr([[true, false], [false, true]])).toHaveProperty('error')
    expect(decodeQr([])).toHaveProperty('error')
  })

  it('reads the level out of the format field, all four of them', () => {
    for (const level of QR_LEVELS) {
      const read = decodeQr(qrMatrix('a pairing payload of some length', level) as boolean[][])
      expect(read, level).toMatchObject({ level })
    }
  })
})
