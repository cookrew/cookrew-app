// A KEYSTROKE BATCH IS TYPED ONCE, HOWEVER OFTEN IT ARRIVES (main/once-by-key.ts).
import { describe, expect, it } from 'vitest'
import { BATCH_ID, createOnceByKey } from '../src/main/once-by-key'

describe('once by key', () => {
  it('runs the first arrival and hands every repeat its verdict', async () => {
    const once = createOnceByKey<string>()
    let runs = 0
    const run = async (): Promise<string> => `typed ${(runs += 1)}`
    expect(await once('t1:a.1', run)).toBe('typed 1')
    expect(await once('t1:a.1', run)).toBe('typed 1')
    expect(await once('t1:a.2', run)).toBe('typed 2')
    expect(runs).toBe(2)
  })

  it('shares a run still in flight with a repeat that lands meanwhile', async () => {
    const once = createOnceByKey<number>()
    let runs = 0
    let finish!: (value: number) => void
    const run = (): Promise<number> => {
      runs += 1
      return new Promise((resolve) => void (finish = resolve))
    }
    const first = once('k', run)
    const second = once('k', run)
    finish(7)
    expect(await Promise.all([first, second])).toEqual([7, 7])
    expect(runs).toBe(1)
  })

  it('forgets the oldest key past its bound', async () => {
    const once = createOnceByKey<number>(2)
    let runs = 0
    const run = async (): Promise<number> => (runs += 1)
    await once('a', run)
    await once('b', run)
    await once('c', run)
    await once('a', run)
    expect(runs).toBe(4)
  })

  it('takes only plain, short ids', () => {
    expect(BATCH_ID.test('0f3a9c1e-2b7d.1z')).toBe(true)
    expect(BATCH_ID.test('')).toBe(false)
    expect(BATCH_ID.test('a b')).toBe(false)
    expect(BATCH_ID.test('x'.repeat(81))).toBe(false)
  })
})
