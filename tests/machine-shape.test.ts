import { describe, expect, it } from 'vitest'
import type { MachineProfile } from '../src/shared/fleet'
import { machineCaption, machineShape, machineSvg } from '../src/shared/machine-shape'

const p = (over: Partial<MachineProfile>): MachineProfile => ({ kind: 'unknown', model: null, label: null, vendor: null, os: 'other', osVersion: null, arch: 'arm64', cpus: null, memoryGb: null, evidence: [], ...over })

describe('a machine drawn as what it is (owner 2026-11-10: “shape of a computer”)', () => {
  it('picks the shape from the kind it reports, and a Mac by its model', () => {
    expect(machineShape(p({ kind: 'laptop', os: 'darwin', label: 'MacBook Pro 16-inch' }))).toBe('macbook')
    expect(machineShape(p({ kind: 'desktop', os: 'darwin', label: 'Mac mini' }))).toBe('mini')
    expect(machineShape(p({ kind: 'desktop', os: 'darwin', label: 'iMac 24-inch' }))).toBe('imac')
    expect(machineShape(p({ kind: 'desktop', os: 'darwin', label: 'Mac Studio' }))).toBe('studio')
    expect(machineShape(p({ kind: 'laptop', os: 'win32' }))).toBe('pclaptop')
    expect(machineShape(p({ kind: 'desktop', os: 'linux' }))).toBe('tower')
    expect(machineShape(p({ kind: 'server', os: 'linux' }))).toBe('server')
    expect(machineShape(p({ kind: 'cloud', vendor: 'AWS' }))).toBe('cloud')
    expect(machineShape(p({ kind: 'vm' }))).toBe('vm')
    expect(machineShape(p({ kind: 'sandbox' }))).toBe('sandbox')
    expect(machineShape(p({ kind: 'cluster' }))).toBe('cluster')
    expect(machineShape(null)).toBe('unknown')
  })

  it('says the platform under the name: the model when known, else the system', () => {
    expect(machineCaption(p({ kind: 'laptop', os: 'darwin', label: 'MacBook Pro 16-inch' }))).toBe('MacBook Pro 16-inch')
    expect(machineCaption(p({ kind: 'desktop', os: 'linux', osVersion: 'Ubuntu 24.04' }))).toBe('Linux · Ubuntu 24.04')
    expect(machineCaption(p({ kind: 'cloud', os: 'linux', label: 'AWS EC2', model: 'c7g.2xlarge' }))).toBe('AWS EC2 · c7g.2xlarge')
    expect(machineCaption(p({ kind: 'desktop', os: 'win32' }))).toBe('Windows')
    expect(machineCaption(null)).toBe('Computer')
  })

  it('draws an empty screen to fill in later, and writes a cloud’s provider on it', () => {
    const svg = machineSvg('cloud', 'AWS')
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 200 150"/)
    expect(svg).toMatch(/<g data-screen="[\d.]+ [\d.]+ [\d.]+ [\d.]+"><\/g>/)
    expect(svg).toContain('>AWS<')
    expect(machineSvg('macbook', null)).not.toContain('class="vendor"')
  })

  it('never writes what it was given unescaped', () => {
    expect(machineSvg('cloud', '<script>x</script>')).not.toContain('<script>')
  })
})
