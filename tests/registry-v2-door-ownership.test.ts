import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { doorHeldElsewhere } from '../src/shared/door-ownership'

/**
 * ONE NAME, ONE HOLDER — at the registry (V3-18 · A3).
 *
 * The thing this exists for: two Macs of one account, cloned from the same
 * repo, derive the same slug. The relay refuses the second — correctly — and
 * says nothing, so the team saved, the door never opened, and the owner had a
 * URL answering from a machine they did not mean.
 *
 * The registry is where the rule can be CHECKED BEFORE the dial: every desktop
 * files the doors it holds, so a save sheet on the second Mac can ask "who has
 * alpha?" and get a name and a day. What is tested here is that the answer is
 * always exactly one machine, that taking it is told to every device, and that
 * one Mac cannot file a claim on behalf of another.
 */

const PASSWORD = 'correct horse battery staple'

const device = (name: string) => ({
  id: randomUUID(),
  kind: 'desktop' as const,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

interface Up {
  origin: string
  close: () => Promise<void>
}

async function up(): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-doors-'))
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir, {
      limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000, joinPerMinute: 1000 }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      })
  }
}

let site: Up
beforeAll(async () => {
  site = await up()
})
afterAll(async () => {
  await site.close()
})

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${site.origin}${p}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T

interface Mac {
  deviceId: string
  name: string
  token: string
}

interface Owner {
  username: string
  first: Mac
  second: Mac
}

let minted = 0
/**
 * AN ACCOUNT WITH TWO MACS ON IT — the whole premise.
 *
 * The second joins by code rather than by password, because a password on an
 * unknown machine is what the v3 ladder refuses (V3-09/V3-10). It is also how
 * a second Mac really arrives.
 */
async function twoMacs(): Promise<Owner> {
  const username = `holder${++minted}`
  const one = device('MacBook Pro')
  const claimed = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: one })
  expect(claimed.status).toBe(201)
  const first = (await bodyOf<{ session: { token: string } }>(claimed)).session.token

  const code = (
    await bodyOf<{ code: string }>(
      await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(first))
    )
  ).code
  const two = device('Mac Studio')
  const joined = await call('POST', '/v2/join', { code, device: two })
  expect(joined.status).toBe(201)
  const second = (await bodyOf<{ token: string }>(joined)).token

  return {
    username,
    first: { deviceId: one.id, name: one.name, token: first },
    second: { deviceId: two.id, name: two.name, token: second }
  }
}

/** A desktop files itself, with the doors it is holding. */
const fileDesktop = (mac: Mac, doors?: readonly string[]): Promise<Response> =>
  call(
    'PUT',
    `/v2/me/desktops/${encodeURIComponent(mac.deviceId)}`,
    { name: mac.name, workspaces: [], ...(doors === undefined ? {} : { doors }) },
    bearer(mac.token)
  )

interface MeBody {
  desktops: readonly { deviceId: string; name: string; doors: readonly { team: string; since: number }[] }[]
}
const me = async (mac: Mac): Promise<MeBody> =>
  bodyOf<MeBody>(await call('GET', '/v2/me', undefined, bearer(mac.token)))

const events = async (mac: Mac): Promise<readonly { kind: string; device?: string }[]> =>
  (
    await bodyOf<{ events: readonly { kind: string; device?: string }[] }>(
      await call('GET', '/v2/me/events?since=0', undefined, bearer(mac.token))
    )
  ).events

describe('a desktop files the doors it holds', () => {
  it('appears on /v2/me with a since, for every device of the account', async () => {
    const owner = await twoMacs()
    expect((await fileDesktop(owner.first, ['alpha'])).status).toBe(204)

    // Read from the OTHER Mac: the save sheet that needs this answer is the
    // one on the machine that does not hold the door.
    const seen = await me(owner.second)
    const holder = seen.desktops.find((d) => d.deviceId === owner.first.deviceId)
    expect(holder?.doors).toHaveLength(1)
    expect(holder?.doors[0].team).toBe('alpha')
    expect(holder?.doors[0].since).toBeGreaterThan(0)
  })

  it('is what the save sheet asks, and it names the other Mac', async () => {
    const owner = await twoMacs()
    await fileDesktop(owner.first, ['alpha'])
    await fileDesktop(owner.second, [])
    const seen = await me(owner.second)
    // The registry's body and the client's rule, joined exactly as the sheet
    // joins them.
    expect(doorHeldElsewhere(seen.desktops, 'alpha', owner.second.deviceId)).toMatchObject({
      deviceId: owner.first.deviceId,
      name: 'MacBook Pro'
    })
    expect(doorHeldElsewhere(seen.desktops, 'alpha', owner.first.deviceId)).toBeNull()
  })

  it('answers an empty list rather than nothing, for a desktop that holds none', async () => {
    // A client that had to read a missing field as "none" would be reading an
    // older registry's silence as an answer.
    const owner = await twoMacs()
    await fileDesktop(owner.first)
    expect((await me(owner.first)).desktops[0].doors).toEqual([])
  })

  it('keeps the claims when a PUT does not mention them', async () => {
    // A desktop renaming a workspace has not stopped serving, and a PUT that
    // quietly emptied the list would hand every door back to nobody.
    const owner = await twoMacs()
    await fileDesktop(owner.first, ['alpha'])
    await fileDesktop(owner.first)
    expect((await me(owner.first)).desktops[0].doors.map((d) => d.team)).toEqual(['alpha'])
  })

  it('RELEASES them for an empty list, which is a statement', async () => {
    const owner = await twoMacs()
    await fileDesktop(owner.first, ['alpha'])
    await fileDesktop(owner.first, [])
    expect((await me(owner.first)).desktops[0].doors).toEqual([])
  })

  it('refuses a slug the hub would refuse as a bad name', async () => {
    const owner = await twoMacs()
    for (const bad of [['Alpha'], ['@drej/alpha'], ['al pha'], [''], ['a'.repeat(65)], [42]]) {
      const filed = await fileDesktop(owner.first, bad as unknown as readonly string[])
      expect(filed.status, JSON.stringify(bad)).toBe(400)
    }
    // And nothing was written by the attempt.
    expect((await me(owner.first)).desktops).toEqual([])
  })

  it('is only about the desktop filing it — one Mac cannot speak for another', async () => {
    const owner = await twoMacs()
    const impostor = await call(
      'PUT',
      `/v2/me/desktops/${encodeURIComponent(owner.first.deviceId)}`,
      { name: 'MacBook Pro', workspaces: [], doors: ['alpha'] },
      bearer(owner.second.token)
    )
    expect(impostor.status).toBe(403)
  })
})

describe('the second Mac takes the door', () => {
  it('leaves exactly one holder, and it is the new one', async () => {
    const owner = await twoMacs()
    await fileDesktop(owner.first, ['alpha'])
    expect((await fileDesktop(owner.second, ['alpha'])).status).toBe(204)

    const seen = await me(owner.first)
    const holding = seen.desktops.filter((d) => d.doors.some((x) => x.team === 'alpha'))
    expect(holding).toHaveLength(1)
    expect(holding[0].deviceId).toBe(owner.second.deviceId)
    // And the Mac that lost it now sees itself holding nothing.
    expect(seen.desktops.find((d) => d.deviceId === owner.first.deviceId)?.doors).toEqual([])
  })

  it('TELLS EVERY DEVICE, naming the machine that took it', async () => {
    const owner = await twoMacs()
    await fileDesktop(owner.first, ['alpha'])
    await fileDesktop(owner.second, ['alpha'])
    // Read on the Mac that LOST it: it may have been asleep when the relay
    // superseded its line, and "my team is offline and I do not know why" is
    // the failure this lane exists to end.
    const moved = (await events(owner.first)).filter((e) => e.kind === 'door-moved')
    expect(moved).toHaveLength(1)
    expect(moved[0].device).toBe('Mac Studio')
  })

  it('says nothing when a holder re-files what it already holds', async () => {
    const owner = await twoMacs()
    await fileDesktop(owner.first, ['alpha'])
    await fileDesktop(owner.first, ['alpha'])
    await fileDesktop(owner.first, ['alpha', 'beta'])
    expect((await events(owner.first)).filter((e) => e.kind === 'door-moved')).toHaveLength(0)
  })

  it('does not disturb the doors it did not name', async () => {
    const owner = await twoMacs()
    await fileDesktop(owner.first, ['alpha', 'beta'])
    await fileDesktop(owner.second, ['alpha'])
    const seen = await me(owner.first)
    expect(seen.desktops.find((d) => d.deviceId === owner.first.deviceId)?.doors.map((d) => d.team)).toEqual(['beta'])
  })

  it('keeps the original since through somebody else’s move', async () => {
    // "served by MacBook Pro since Tue" must not restart because a different
    // door changed hands in the same PUT.
    const owner = await twoMacs()
    await fileDesktop(owner.first, ['alpha', 'beta'])
    const before = (await me(owner.first)).desktops[0].doors.find((d) => d.team === 'beta')?.since
    await fileDesktop(owner.second, ['alpha'])
    const after = (await me(owner.first)).desktops
      .find((d) => d.deviceId === owner.first.deviceId)
      ?.doors.find((d) => d.team === 'beta')?.since
    expect(after).toBe(before)
  })

  it('is one account’s business — another account holding the same slug is untouched', async () => {
    // `alpha` is a name under a HANDLE. @drej/alpha and @sam/alpha are two
    // doors, and neither takes anything from the other.
    const drej = await twoMacs()
    const sam = await twoMacs()
    await fileDesktop(drej.first, ['alpha'])
    await fileDesktop(sam.first, ['alpha'])
    expect((await me(drej.first)).desktops[0].doors.map((d) => d.team)).toEqual(['alpha'])
    expect((await me(sam.first)).desktops[0].doors.map((d) => d.team)).toEqual(['alpha'])
    expect((await events(drej.first)).filter((e) => e.kind === 'door-moved')).toHaveLength(0)
  })
})
