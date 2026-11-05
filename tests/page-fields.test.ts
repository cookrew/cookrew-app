import { describe, expect, it } from 'vitest'
import { fieldsInFrame, MAX_FIELDS, sanitizeFieldReport } from '../src/main/page-fields'
import { sanitizePaste } from '../src/shared/cast-input'

/**
 * WHERE THE PAGE'S TEXT FIELDS ARE comes from the page itself — any site — so
 * it is sanitized like the rest of the wire: a phone may at worst raise its
 * keyboard on a lie, never receive anything unbounded.
 */
describe('sanitizeFieldReport', () => {
  const report = (value: unknown): string => JSON.stringify(value)

  it('keeps a well-formed report', () => {
    expect(
      sanitizeFieldReport(
        report({
          focus: { editable: true, rect: [10, 20, 300, 30], mode: 'email' },
          fields: [{ rect: [10, 20, 300, 30], mode: 'email' }, { rect: [10, 80, 300, 60], mode: 'text' }]
        })
      )
    ).toEqual({
      focus: { editable: true, rect: [10, 20, 300, 30], mode: 'email' },
      fields: [
        { rect: [10, 20, 300, 30], mode: 'email' },
        { rect: [10, 80, 300, 60], mode: 'text' }
      ]
    })
  })

  it('a hello, junk, or something too big is not a report', () => {
    expect(sanitizeFieldReport('hello')).toBeNull()
    expect(sanitizeFieldReport('{not json')).toBeNull()
    expect(sanitizeFieldReport(42)).toBeNull()
    expect(sanitizeFieldReport('x'.repeat(40_000))).toBeNull()
    expect(sanitizeFieldReport('null')).toBeNull()
  })

  it('drops malformed rects and unknown modes, and caps the count', () => {
    const out = sanitizeFieldReport(
      report({
        focus: { editable: false, rect: [1, 2, 3, 4], mode: 'numeric' },
        fields: [
          { rect: [1, 2, 3], mode: 'text' },
          { rect: [1, 2, -3, 4] },
          { rect: [1, 2, 'x', 4] },
          { rect: [5, 5, 50, 20], mode: 'evil' },
          ...Array.from({ length: 200 }, () => ({ rect: [0, 0, 10, 10] }))
        ]
      })
    )
    // Not editable: no rect, no mode carried along.
    expect(out?.focus).toEqual({ editable: false, rect: null, mode: 'text' })
    expect(out?.fields[0]).toEqual({ rect: [5, 5, 50, 20], mode: 'text' })
    expect(out?.fields.length).toBeLessThanOrEqual(MAX_FIELDS)
  })
})

describe('fieldsInFrame', () => {
  it('scales CSS px of the visual viewport into frame px, rounded', () => {
    expect(
      fieldsInFrame(
        { focus: { editable: true, rect: [10, 20, 30.4, 40], mode: 'text' }, fields: [{ rect: [1, 2, 3, 4], mode: 'tel' }] },
        2
      )
    ).toEqual({
      focus: { editable: true, rect: [20, 40, 61, 80], mode: 'text' },
      fields: [{ rect: [2, 4, 6, 8], mode: 'tel' }]
    })
  })
  it('a nonsense scale is 1', () => {
    expect(fieldsInFrame({ focus: { editable: false, rect: null, mode: 'text' }, fields: [{ rect: [1, 2, 3, 4], mode: 'text' }] }, 0).fields[0].rect).toEqual([1, 2, 3, 4])
  })
})

describe('sanitizePaste', () => {
  it('takes a bounded paste and nothing else', () => {
    expect(sanitizePaste({ t: 'paste', text: '你好' })).toBe('你好')
    expect(sanitizePaste({ t: 'paste', text: '' })).toBeNull()
    expect(sanitizePaste({ t: 'paste', text: 'x'.repeat(4097) })).toBeNull()
    expect(sanitizePaste({ t: 'paste', text: 7 })).toBeNull()
    expect(sanitizePaste({ t: 'text', text: 'x' })).toBeNull()
    expect(sanitizePaste(null)).toBeNull()
  })
})
