import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { maySetUpHere } from '../registry/src/v2-second-step'
import { finishSetupWithTotp } from './support/second-step'
import { grantWorld, PASSWORD, type GrantWorld } from './support/grant-world'

/**
 * AN ACCOUNT AN OLD APP MADE AND COULD NOT FINISH (auth UX 2026-11-09).
 *
 * App 0.5.x creates an account directly, is told it needs a second step, and
 * stops: it has no screen for one and throws away the key it attached. The
 * account must still be finishable — on auth.cookrew.dev, from whatever device
 * the person then uses — and only until a second step exists.
 */

let world: GrantWorld
beforeAll(async () => {
  world = await grantWorld()
})
afterAll(async () => world.close())

const desk = () => ({ id: randomUUID(), kind: 'desktop', name: 'Old app Mac', jwk: { kty: 'OKP', crv: 'Ed25519', x: randomBytes(32).toString('base64url') } })

describe('an unfinished account', () => {
  it('may finish its set-up from a device it has never seen, once; afterwards only its own devices may', async () => {
    const username = `unfinished${Date.now() % 100000}`
    const made = await fetch(`${world.origin}/v2/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD, device: desk() })
    })
    expect(made.status).toBe(403)
    const body = (await made.json()) as { error: string; message: string; pending: string }
    expect(body.error).toBe('second_step_setup')
    // What 0.5.x shows, and then it stops: nothing finished, the key thrown away.
    expect(body.message).toContain('auth.cookrew.dev')
    const browser = randomUUID()
    expect(maySetUpHere(world.v2, username, browser)).toBe(true)

    // A person who finishes it (here on the pending, as the page does).
    await finishSetupWithTotp(world.origin, body.pending)
    expect(world.v2.accounts.get(username)?.setupPending).toBe(false)
    expect(maySetUpHere(world.v2, username, randomUUID())).toBe(false)
  })

  it('an account from before the ruling is never treated as unfinished', async () => {
    const username = `older${Date.now() % 100000}`
    await world.account(username)
    expect(world.v2.accounts.get(username)?.setupPending).toBeUndefined()
    expect(maySetUpHere(world.v2, username, randomUUID())).toBe(false)
  })
})
