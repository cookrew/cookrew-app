// THE UNLOCK ROUTES INSIDE THE SESSION: the Mac's own paths, the token inside, and a
// refusal read as a refusal.
import { describe, expect, it, vi } from 'vitest'
import type { SealClient, SealRequest } from '../src/renderer/src/path/seal-client'
import { sealedUnlockApi } from '../src/renderer/src/use/unlock-sealed'

const client = (status: number, body: unknown): SealClient & { asked: SealRequest[] } => {
  const asked: SealRequest[] = []
  return {
    asked,
    request: vi.fn(async (input: SealRequest) => {
      asked.push(input)
      return { status, body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)) }
    }),
    close: () => undefined
  }
}

const auth = (): Record<string, string> => ({ authorization: 'Bearer t' })

describe('sealedUnlockApi', () => {
  it('asks the Mac\'s own route with the token inside', async () => {
    const line = client(200, { ok: true, key: 'k', challenge: 'c' })
    expect(await sealedUnlockApi(line, auth).begin()).toEqual({ ok: true, key: 'k', challenge: 'c' })
    expect(line.asked[0]).toMatchObject({ method: 'POST', path: '/api/use/sources/unlock/begin', headers: { authorization: 'Bearer t' } })
  })

  it('sends what was sealed and nothing else', async () => {
    const line = client(200, { ok: true, outcome: 'unlocked' })
    await sealedUnlockApi(line, auth).send('e.box')
    expect(line.asked[0].path).toBe('/api/use/sources/unlock')
    expect(JSON.parse(line.asked[0].body ?? '')).toEqual({ sealed: 'e.box' })
  })

  it('a refusal comes back as one, so the sheet can show it', async () => {
    const line = client(403, { ok: false, outcome: 'refused', error: 'Remote control is off.' })
    expect(await sealedUnlockApi(line, auth).send('e.box')).toMatchObject({ ok: false, error: 'Remote control is off.' })
  })

  it('an answer that is not a verdict is an error, whatever its status', async () => {
    await expect(sealedUnlockApi(client(403, { error: 'Pair this device' }), auth).begin()).rejects.toThrow('Pair this device')
    await expect(sealedUnlockApi(client(502, 'nope'), auth).begin()).rejects.toThrow()
  })
})
