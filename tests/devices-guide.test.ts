// YOUR COMPUTERS, ONE MODEL LOGIN (shared/devices-guide.ts): the lines that put
// an agent on each computer, chosen by that computer's own system, and the four
// steps of the guide in order.
import { describe, expect, it } from 'vitest'
import { guideSteps, harnessLines } from '../src/shared/devices-guide'
import { setupLineAllowed } from '../src/shared/route-lines'

describe('harnessLines', () => {
  it('gives Claude Code and Codex a line each that runs as it stands on a Mac and on Linux', () => {
    for (const [os, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']] as const) {
      const lines = harnessLines(os, arch)
      expect(lines.map((l) => l.harness)).toEqual(['claude', 'codex'])
      for (const l of lines) {
        expect(l.line).not.toMatch(/sk-|key=|token/i)
        expect(l.line !== null && setupLineAllowed(l.line)).toBe(true)
      }
    }
  })

  it('says it has no line for a system it does not know, rather than guess', () => {
    expect(harnessLines('other', 'x64')).toEqual([])
    expect(harnessLines('win32', 'x64').every((l) => l.line === null)).toBe(true)
  })
})

describe('guideSteps', () => {
  const desktops = [
    { id: 'aaaaaaaaaaaa', name: 'Solis-Core', online: true, providerId: null, os: 'linux' as const, arch: 'x64' },
    { id: 'bbbbbbbbbbbb', name: 'Laptop', online: false, providerId: 'laptop', os: 'darwin' as const, arch: 'arm64' }
  ]

  it('starts at signing in when this computer has no account', () => {
    expect(guideSteps({ signedIn: false, desktops: [], modelHere: false, switches: { magpie: true, magpieRemote: true } })[0]).toMatchObject({ id: 'computers', done: false })
  })

  it('marks a step done only on what it can see', () => {
    const steps = guideSteps({ signedIn: true, desktops, modelHere: false, switches: { magpie: true, magpieRemote: true } })
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ['computers', true],
      ['agents', false],
      ['model', true],
      ['use', true]
    ])
  })

  it('says the model step is done here when this computer has a model, and use waits on both switches', () => {
    const steps = guideSteps({ signedIn: true, desktops: [], modelHere: true, switches: { magpie: true, magpieRemote: false } })
    expect(steps.find((s) => s.id === 'model')?.done).toBe(true)
    expect(steps.find((s) => s.id === 'use')).toMatchObject({ done: false, blocked: expect.stringContaining('Magpie remote') })
  })
})
