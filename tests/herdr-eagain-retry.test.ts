import { describe, expect, it } from 'vitest'
import { isTransientHerdrError, runWithHerdrRetry } from '../src/main/herdr-multiplexer'

describe('herdr EAGAIN retry — a switch burst must not read as a dead server', () => {
  it('recognises the transient forms and nothing else', () => {
    expect(isTransientHerdrError({ code: 'EAGAIN' })).toBe(true)
    expect(isTransientHerdrError({ stderr: 'lost connection to server: Resource temporarily unavailable (os error 35)' })).toBe(true)
    expect(isTransientHerdrError({ message: 'spawn EAGAIN' })).toBe(true)
    expect(isTransientHerdrError({ stderr: 'no such pane' })).toBe(false)
    expect(isTransientHerdrError({ code: 'ENOENT' })).toBe(false)
    expect(isTransientHerdrError(null)).toBe(false)
  })

  it('retries a transient EAGAIN and returns the eventual success', () => {
    let n = 0
    const out = runWithHerdrRetry(() => {
      n++
      if (n < 3) throw { stderr: 'Resource temporarily unavailable (os error 35)' }
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(n).toBe(3)
  })

  it('rethrows a NON-transient failure immediately, no retries', () => {
    let n = 0
    expect(() =>
      runWithHerdrRetry(() => {
        n++
        throw Object.assign(new Error('no such pane'), { stderr: 'no such pane' })
      })
    ).toThrow(/no such pane/)
    expect(n).toBe(1)
  })

  it('gives up after the last attempt if EAGAIN never clears — a real dead server still surfaces', () => {
    let n = 0
    expect(() =>
      runWithHerdrRetry(() => {
        n++
        throw { code: 'EAGAIN' }
      }, 4)
    ).toThrow()
    expect(n).toBe(4)
  })
})
