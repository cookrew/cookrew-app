import { beforeEach, describe, expect, it, vi } from 'vitest'

/** What this machine says about itself: sysctl is asked on a Mac and nowhere else. */

const asked: string[] = []

vi.mock('node:child_process', () => ({
  execFileSync: (file: string) => {
    asked.push(file)
    return 'MacBookPro18,3\n'
  }
}))

vi.mock('node:os', () => ({ hostname: () => 'solis-model-test' }))

import { localDeviceName, localModel } from '../src/main/device-name'

beforeEach(() => {
  asked.length = 0
})

describe('the local facts', () => {
  it('asks sysctl on a Mac', () => {
    expect(localModel('darwin')).toBe('MacBookPro18,3')
    expect(asked).toEqual(['sysctl'])
  })

  it('never asks sysctl elsewhere: hw.model on a BSD is a CPU, not a Mac', () => {
    expect(localModel('linux')).toBe('')
    expect(localModel('freebsd')).toBe('')
    expect(asked).toEqual([])
  })

  it('names a Linux box for what it is', () => {
    expect(localDeviceName([], 'linux')).toBe('Linux · solis-model-test')
  })

  it('counts past a name already on the account', () => {
    expect(localDeviceName(['Linux · solis-model-test'], 'linux')).toBe('Linux · solis-model-test (2)')
  })
})
