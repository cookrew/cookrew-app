import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RegistryHostSettings } from '../src/main/registry-settings'
import { resolveRegistryHosts } from '../src/shared/registry-host'

// The settings surface exists so "configured, never inferred" is REACHABLE.
// An env var configures whoever launches the process, which on a packaged app
// is nobody — so the empty default was correct AND unreachable, which is the
// dead end Magpie hit.

const settings = (): RegistryHostSettings =>
  new RegistryHostSettings(path.join(mkdtempSync(path.join(tmpdir(), 'cr-hosts-')), 'hosts.json'))

describe('recording a trust decision', () => {
  it('starts empty — nothing is recognised until an owner says so', () => {
    expect(settings().list()).toEqual([])
  })

  it('adds, normalises case, and is idempotent', () => {
    const store = settings()
    store.add('Registry.Example.com')
    expect(store.add('registry.example.com')).toEqual(['registry.example.com'])
  })

  it('removes, and removing what was never there is not an error', () => {
    const store = settings()
    store.add('a.example.com')
    expect(store.remove('a.example.com')).toEqual([])
    expect(store.remove('never.example.com')).toEqual([])
  })

  it('refuses an empty host rather than storing a blank trust entry', () => {
    expect(() => settings().add('   ')).toThrow()
  })
})

describe('a trust list that cannot be read recognises NOTHING', () => {
  it('reads a corrupt file as empty, never as permissive', () => {
    // Fail-closed: a half-parsed trust list degrading into a permissive one is
    // how a corrupted file becomes a supply-chain redirect.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cr-hosts-')), 'hosts.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    expect(new RegistryHostSettings(file).list()).toEqual([])
  })

  it('reads a non-array as empty', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cr-hosts-')), 'hosts.json')
    writeFileSync(file, '{"host":"evil.example.com"}', 'utf8')
    expect(new RegistryHostSettings(file).list()).toEqual([])
  })

  it('drops non-string entries rather than coercing them', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cr-hosts-')), 'hosts.json')
    writeFileSync(file, '["good.example.com", 42, null]', 'utf8')
    expect(new RegistryHostSettings(file).list()).toEqual(['good.example.com'])
  })
})

describe('the surface and the resolution agree', () => {
  it('a host added in settings is recognised in a PACKAGED build', () => {
    // The point of the whole slice: a shipped app can now recognise a
    // registry, and only one an owner deliberately added.
    const store = settings()
    store.add('registry.example.com')
    const resolved = resolveRegistryHosts({
      configured: '',
      settings: store.list(),
      packaged: true
    })
    expect(resolved).toMatchObject({ hosts: ['registry.example.com'], source: 'configured' })
  })

  it('an empty settings list in a packaged build still recognises nothing', () => {
    expect(
      resolveRegistryHosts({ configured: '', settings: settings().list(), packaged: true }).hosts
    ).toEqual([])
  })

  it('survives a crash mid-write: the previous list stays intact', () => {
    // Sibling-plus-rename. A truncated trust list would read as empty and lock
    // an owner out of the registry they configured.
    const dir = mkdtempSync(path.join(tmpdir(), 'cr-hosts-'))
    const file = path.join(dir, 'hosts.json')
    const store = new RegistryHostSettings(file)
    store.add('first.example.com')
    const before = readFileSync(file, 'utf8')
    store.add('second.example.com')
    expect(JSON.parse(before)).toEqual(['first.example.com'])
    expect(store.list()).toEqual(['first.example.com', 'second.example.com'])
  })
})
