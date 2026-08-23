import { describe, expect, it } from 'vitest'
import {
  REGISTRY_HOST_SETTING,
  registryHostHelp,
  resolveRegistryHosts
} from '../src/shared/registry-host'

// A DEFAULT HOST IS A DEFAULT RECIPIENT FOR AN AUTHOR'S PAYOUT ADDRESS.
//
// Magpie's give-up #2: the shared install link's only instruction cannot work,
// because the recognised-host list is empty by default and so no link is ever
// recognised. The empty default was DELIBERATE (R21: configured, never
// inferred — the app must not learn to trust a host because a page it was
// showing claimed to be one), and it is also a dead end.
//
// Both halves are load-bearing, and publish makes the stakes concrete: a
// publish pushes a signed manifest and a payout address to whatever host is
// configured. A wrong registry is not a broken link, it is a supply-chain
// redirect for money and trust bindings. So: never a silent default, and never
// a dead end either.

const resolve = (over: Partial<Parameters<typeof resolveRegistryHosts>[0]> = {}) =>
  resolveRegistryHosts({ configured: '', settings: [], packaged: true, ...over })

describe('configured, never inferred', () => {
  it('recognises exactly the hosts the owner configured', () => {
    const result = resolve({ configured: 'registry.example.com' })
    expect(result).toMatchObject({ hosts: ['registry.example.com'], source: 'configured' })
  })

  it('takes a comma-separated list, trimmed', () => {
    expect(resolve({ configured: ' a.example.com , b.example.com ' }).hosts).toEqual([
      'a.example.com',
      'b.example.com'
    ])
  })

  it('merges the settings surface with the environment, without duplicates', () => {
    // The settings surface exists so "configured" is reachable without an env
    // var — the same trust decision, made somewhere an owner can find it.
    const result = resolve({
      configured: 'a.example.com',
      settings: ['b.example.com', 'a.example.com']
    })
    expect(result.hosts).toEqual(['a.example.com', 'b.example.com'])
    expect(result.source).toBe('configured')
  })
})

describe('never a silent default', () => {
  it('recognises NOTHING out of the box in a packaged build', () => {
    // The whole ruling in one assertion. A default here would be a default
    // recipient for payout addresses.
    expect(resolve()).toMatchObject({ hosts: [], source: 'none' })
  })

  it('does not invent a host from a plausible-looking one', () => {
    // No wildcards, no suffix matching, no "well it looks like our domain".
    const result = resolve({ configured: 'registry.example.com' })
    expect(result.hosts).not.toContain('evil-registry.example.com')
    expect(result.hosts).toHaveLength(1)
  })

  it('refuses a wildcard rather than expanding trust', () => {
    expect(resolve({ configured: '*.example.com, *' }).hosts).toEqual([])
  })

  it('refuses anything carrying a path, port-only junk or a scheme mismatch', () => {
    for (const bad of ['http://x.com/install', 'x.com/path', '//x.com', 'not a host']) {
      expect(resolve({ configured: bad }).hosts).toEqual([])
    }
  })
})

describe('never a dead end either', () => {
  it('recognises loopback in an UNPACKAGED build, so the journey works in dev', () => {
    const result = resolve({ packaged: false })
    expect(result.source).toBe('loopback-dev')
    expect(result.hosts).toContain('127.0.0.1')
    expect(result.hosts).toContain('localhost')
  })

  it('carries loopback recognition ONLY where a packaged build cannot', () => {
    // The restriction is the point: a shipped app must never recognise a host
    // nobody chose, and a dev machine must not need a ritual to try the thing.
    expect(resolve({ packaged: true, configured: '' }).hosts).toEqual([])
  })

  it('lets a configured host win over the dev loopback, rather than merging', () => {
    // A developer who configured a real registry meant it; silently adding
    // loopback would make a local server shadow the one they chose.
    const result = resolve({ packaged: false, configured: 'registry.example.com' })
    expect(result.source).toBe('configured')
    expect(result.hosts).toEqual(['registry.example.com'])
  })

  it('the refusal NAMES the setting and how to set it', () => {
    // Magpie's dead end was an instruction that could not work. The refusal
    // has to be the missing instruction, not a shrug.
    const help = registryHostHelp()
    expect(help).toContain(REGISTRY_HOST_SETTING)
    expect(help.length).toBeGreaterThan(60)
    // It must say where the setting lives, not only that one exists.
    expect(help).toMatch(/settings/i)
  })

  it('explains WHY it refuses, because the refusal looks like a bug otherwise', () => {
    expect(registryHostHelp()).toMatch(/payout|money|trust|supply/i)
  })
})
