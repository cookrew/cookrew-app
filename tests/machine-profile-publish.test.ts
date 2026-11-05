import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Accounts, type AccountsDeps } from '../src/main/account-v2'
import type { MachineProfile } from '../src/shared/levels'

// The desktop files its profile and app version with the record PUT it already
// makes. Invented account, invented profile.

const PROFILE: MachineProfile = {
  kind: 'laptop',
  model: 'MacBookPro18,1',
  label: 'MacBook Pro 16-inch (2021)',
  vendor: 'Apple',
  os: 'darwin',
  osVersion: 'macOS 26.5',
  arch: 'arm64',
  cpus: 10,
  memoryGb: 32,
  evidence: ['hw.model=MacBookPro18,1', 'battery=present']
}

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

async function claimed(machine?: AccountsDeps['machine']) {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-publish-'))
  dirs.push(base)
  const bodies: string[] = []
  let index = 0
  const replies = [{ status: 201, body: { username: 'mira', deviceId: 'ignored', session: { token: 'tok', exp: 2e12 } } }, { status: 204 }]
  const fetch = (_url: string, init?: RequestInit): Promise<Response> => {
    bodies.push(String(init?.body ?? ''))
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    return Promise.resolve(new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status }))
  }
  const accounts = new Accounts({ base, origin: 'https://registry.test', fetch, deviceName: 'Test Mac', ...(machine ? { machine } : {}) })
  await accounts.claim({ username: 'mira', password: 'correct-horse-battery' })
  return { accounts, bodies }
}

describe('the desktop record carries the machine profile', () => {
  it('adds profile and appVersion to the PUT', async () => {
    const { accounts, bodies } = await claimed(async () => ({ profile: PROFILE, appVersion: '0.3.0' }))
    await accounts.registerDesktop([{ id: 'w1', name: 'Invented' }])
    const body = JSON.parse(bodies[1]) as Record<string, unknown>
    expect(body.profile).toEqual(PROFILE)
    expect(body.appVersion).toBe('0.3.0')
    expect(body.workspaces).toEqual([{ id: 'w1', name: 'Invented' }])
  })

  it('sends neither field without a probe, or when the probe failed', async () => {
    const none = await claimed()
    await none.accounts.registerDesktop([])
    expect(JSON.parse(none.bodies[1])).not.toHaveProperty('profile')

    const failed = await claimed(() => Promise.reject(new Error('probe failed')))
    await failed.accounts.registerDesktop([])
    const body = JSON.parse(failed.bodies[1]) as Record<string, unknown>
    expect(body).not.toHaveProperty('profile')
    expect(body).not.toHaveProperty('appVersion')
  })
})
