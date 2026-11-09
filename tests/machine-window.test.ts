import { describe, expect, it } from 'vitest'
import { machineWindowPlan, allowedInMachineWindow } from '../src/main/machine-window'

/**
 * WORKING IN ANOTHER MACHINE FROM THIS ONE (owner 2026-11-10): its own page,
 * the one a phone uses, opened here in a window of its own, already let in by
 * the key this machine holds for it.
 */

const input = {
  registryOrigin: 'https://cookrew.dev',
  username: 'anvztor',
  machineId: '135928f2-0000-4000-8000-000000000001',
  key: 'machine-key_abc'
}

describe('a window onto another machine', () => {
  it('opens that machine’s own page down the relay, its key in the fragment where the relay never sees it', () => {
    const plan = machineWindowPlan(input)
    expect(plan?.url).toBe('https://cookrew.dev/relay/@anvztor/desktop/135928f2-0000-4000-8000-000000000001/#pair=machine-key_abc')
    expect(new URL(plan?.url ?? '').search).toBe('')
  })

  it('keeps each machine’s page in a store of its own, and never carries this machine’s cookrew.dev session (security review)', () => {
    const plan = machineWindowPlan(input)
    expect(plan?.partition).toBe('persist:cookrew-machine-135928f2-0000-4000-8000-000000000001')
    expect(JSON.stringify(plan)).not.toContain('session')
  })

  it('has no plan for anything that is not a machine of a signed-in account', () => {
    expect(machineWindowPlan({ ...input, machineId: '../../evil' })).toBeNull()
    expect(machineWindowPlan({ ...input, key: '' })).toBeNull()
    expect(machineWindowPlan({ ...input, registryOrigin: 'not a url' })).toBeNull()
  })

  it('goes only where signing in and that machine take it: cookrew.dev, its sign-in host, a provider’s page; https only', () => {
    const plan = machineWindowPlan(input)
    if (!plan) throw new Error('no plan')
    expect(allowedInMachineWindow(plan, 'https://cookrew.dev/relay/@anvztor/desktop/135928f2-0000-4000-8000-000000000001/w/dev')).toBe(true)
    expect(allowedInMachineWindow(plan, 'https://auth.cookrew.dev/authorize?x=1')).toBe(true)
    expect(allowedInMachineWindow(plan, 'https://cookrew.dev/me')).toBe(true)
    expect(allowedInMachineWindow(plan, 'https://github.com/login/oauth/authorize')).toBe(true)
    expect(allowedInMachineWindow(plan, 'https://evil.example/')).toBe(false)
    expect(allowedInMachineWindow(plan, 'https://cookrew.dev.evil.example/')).toBe(false)
    expect(allowedInMachineWindow(plan, 'http://cookrew.dev/me')).toBe(false)
  })
})
