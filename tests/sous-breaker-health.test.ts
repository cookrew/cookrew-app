import { describe, expect, it } from 'vitest'
import { createLoopHealth } from '../src/main/loop-health'
import { createSousBreaker } from '../src/main/sous-breaker'

/** The breaker rides on GET /api/health through loop-health's dep seam. */
describe('loop health carries the Sous breaker', () => {
  it('is null when not wired, and the live state when it is', async () => {
    const bare = createLoopHealth({ now: () => 1 })
    expect(bare.snapshot().sous).toBeNull()
    bare.stop()

    const breaker = createSousBreaker({ now: () => 1000, log: () => undefined })
    for (let i = 0; i < 3; i += 1) await breaker.guard(async () => ({ ok: false, reason: 'TimeoutError' }))
    const wired = createLoopHealth({ now: () => 5000, sous: () => breaker.state() })
    const snapshot = wired.snapshot()
    expect(snapshot.sous).toMatchObject({ state: 'open', consecutiveFailures: 3, windowMs: 30_000, trips: 1 })
    expect(JSON.parse(JSON.stringify(snapshot)).sous.openUntil).toBe(31_000)
    wired.stop()
  })

  it('serves no URL and no credential, whatever the failure said', async () => {
    const breaker = createSousBreaker({ now: () => 1000, log: () => undefined })
    const leaky = async (): Promise<{ ok: false; reason: string }> => ({
      ok: false,
      reason: 'fetch failed: http://user:s3cr3t@ollama.internal:11434/api/generate'
    })
    for (let i = 0; i < 3; i += 1) await breaker.guard(leaky)
    const health = createLoopHealth({ now: () => 5000, sous: () => breaker.state() })
    const body = JSON.stringify(health.snapshot())
    expect(body).not.toMatch(/\/\/[^@\s/"]+@/)
    expect(body).not.toContain('s3cr3t')
    expect(body).not.toContain('://')
    health.stop()
  })
})
