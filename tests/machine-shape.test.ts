import { describe, expect, it } from 'vitest'
import type { MachineProfile } from '../src/shared/fleet'
import { machineCaption } from '../src/shared/machine-shape'

const p = (over: Partial<MachineProfile>): MachineProfile => ({ kind: 'unknown', model: null, label: null, vendor: null, os: 'other', osVersion: null, arch: 'arm64', cpus: null, memoryGb: null, evidence: [], ...over })

describe('the line under a machine’s name', () => {
  it('says the platform under the name: the model when known, else the system', () => {
    expect(machineCaption(p({ kind: 'laptop', os: 'darwin', label: 'MacBook Pro 16-inch' }))).toBe('MacBook Pro 16-inch')
    expect(machineCaption(p({ kind: 'desktop', os: 'linux', osVersion: 'Ubuntu 24.04' }))).toBe('Linux · Ubuntu 24.04')
    expect(machineCaption(p({ kind: 'cloud', os: 'linux', label: 'AWS EC2', model: 'c7g.2xlarge' }))).toBe('AWS EC2 · c7g.2xlarge')
    expect(machineCaption(p({ kind: 'desktop', os: 'win32' }))).toBe('Windows')
    expect(machineCaption(null)).toBe('Computer')
  })
})
