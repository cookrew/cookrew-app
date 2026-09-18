import { describe, expect, it } from 'vitest'

/**
 * THE COMPANION'S PORTS ARE A DEPLOYMENT VALUE, not a fixture.
 *
 * Two instances on one machine cannot both hold 8639, so with these pinned no
 * test instance could SERVE a door: the relay dialled it, nothing was
 * listening behind it, and the importer was told the door "didn't answer" —
 * which is how the marketplace came to be untestable in isolation.
 *
 * Loaded through a fresh module registry per case, because the ports are read
 * once at load (main's environment is fixed when the process starts).
 */
async function portsWith(env: Record<string, string | undefined>): Promise<{
  MOBILE_PORT: number
  MOBILE_HTTPS_PORT: number
}> {
  const held = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    vi.resetModules()
    return await import('../src/main/mobile-ports')
  } finally {
    process.env = held
  }
}

import { vi } from 'vitest'

describe('the companion ports follow configuration', () => {
  it('ships on 8639 and 8643 when nothing is configured', async () => {
    const ports = await portsWith({
      COOKREW_MOBILE_PORT: undefined,
      COOKREW_MOBILE_HTTPS_PORT: undefined
    })
    expect(ports.MOBILE_PORT).toBe(8639)
    expect(ports.MOBILE_HTTPS_PORT).toBe(8643)
  })

  it('moves where a second instance is told to listen', async () => {
    const ports = await portsWith({
      COOKREW_MOBILE_PORT: '8659',
      COOKREW_MOBILE_HTTPS_PORT: '8663'
    })
    expect(ports.MOBILE_PORT).toBe(8659)
    expect(ports.MOBILE_HTTPS_PORT).toBe(8663)
  })

  it('keeps the shipped port when the override is not one', async () => {
    // A typo must not move the companion somewhere nobody is looking.
    const ports = await portsWith({
      COOKREW_MOBILE_PORT: 'eight thousand',
      COOKREW_MOBILE_HTTPS_PORT: '70000'
    })
    expect(ports.MOBILE_PORT).toBe(8639)
    expect(ports.MOBILE_HTTPS_PORT).toBe(8643)
  })
})
