// A picture's words show by --zv-wo, written only when the value changes
// (zoom-frame.ts · wordsSeen).
import { describe, expect, it } from 'vitest'
import { wordsSeen } from '../src/renderer/src/zoom/zoom-frame'

const fake = () => {
  const writes: Array<[string, string]> = []
  const el = { style: { setProperty: (k: string, v: string) => void writes.push([k, v]) } }
  return { el: el as unknown as HTMLElement, writes }
}

describe('wordsSeen', () => {
  it('ignores a missing element', () => {
    expect(() => wordsSeen(null, 1)).not.toThrow()
    expect(() => wordsSeen(undefined, 1)).not.toThrow()
  })

  it('writes --zv-wo rounded to two decimals', () => {
    const { el, writes } = fake()
    wordsSeen(el, 0.12345)
    expect(writes).toEqual([['--zv-wo', '0.12']])
  })

  it('writes only when the rounded value changes', () => {
    const { el, writes } = fake()
    wordsSeen(el, 0.5)
    wordsSeen(el, 0.5)
    wordsSeen(el, 0.504)
    expect(writes).toHaveLength(1)
    wordsSeen(el, 0.6)
    expect(writes).toEqual([['--zv-wo', '0.5'], ['--zv-wo', '0.6']])
  })

  it('writes 0 and 1 as plain numbers', () => {
    const { el, writes } = fake()
    wordsSeen(el, 0)
    wordsSeen(el, 1)
    expect(writes).toEqual([['--zv-wo', '0'], ['--zv-wo', '1']])
  })
})
