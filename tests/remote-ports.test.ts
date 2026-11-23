// HAND-MADE TUNNELS TO ANOTHER MAGPIE: their loopback ports are read from Magpie's
// own provider list and denied to a served sandbox. Only addresses are read.
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { configuredEndpointInventory, plainRemoteProviders, providersFile, remoteLoopbackPorts, remoteLoopbackProviders, retainEndpointInventory } from '../src/main/route/remote-ports'

const env = { home: '/Users/x', env: {} }
const list = (providers: unknown[]): string => JSON.stringify({ providers, groups: [], order: [] })

describe('private configured endpoint inventory', () => {
  it('reads all five fields, across providers, without retaining keys', () => {
    const urls = ['https://alpha.example:51001/a', 'http://100.111.112.113:51002/b', 'https://charlie.example:51003/c', 'http://delta.example:51004/d', 'https://echo.example:51005/e']
    const json = list([
      { id: 'remote', preset: 'remote-magpie', anthropic: urls[0], chat: urls[1], responses: urls[2], decide: urls[3], url: urls[4], key: 'not-an-endpoint' },
      { id: 'other', preset: 'custom', chat: 'https://other.example:51006/v1' }
    ])
    expect(configuredEndpointInventory(env, () => json)).toEqual([...urls, 'https://other.example:51006/v1'].map((url) => new URL(url).origin))
  })

  it('retains every observed origin across rewrites, and latches unknown after a gap', () => {
    let current: string[] | null = ['https://a.example:51001']
    const read = retainEndpointInventory(() => current)
    expect(read()).toEqual(['https://a.example:51001'])
    current = []
    expect(read()).toEqual(['https://a.example:51001'])
    current = ['https://b.example:51002']
    expect(read()).toEqual(['https://a.example:51001', 'https://b.example:51002'])
    current = null
    expect(read()).toBeNull()
    current = ['https://b.example:51002']
    expect(read()).toBeNull()
  })

  it('recovers from a missing startup configuration before any provider data can be cached', () => {
    let current: string[] | null = null
    const read = retainEndpointInventory(() => current)
    expect(read(false)).toBeNull()
    current = ['https://setup.example:51003']
    expect(read(false)).toEqual(current)
    current = null
    expect(read(true)).toBeNull()
    current = ['https://setup.example:51003']
    expect(read(false)).toBeNull()
  })

  it('treats a missing file, unreadable or malformed configuration as unknown', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    expect(configuredEndpointInventory(env, () => { throw missing })).toBeNull()
    expect(configuredEndpointInventory(env, () => { throw new Error('denied') })).toBeNull()
    expect(configuredEndpointInventory(env, () => '{broken')).toBeNull()
    expect(configuredEndpointInventory(env, () => list([{ id: 'x', chat: 'not-a-url' }]))).toBeNull()
    expect(configuredEndpointInventory(env, () => list([{ id: 'x', chat: 4 }]))).toBeNull()
    expect(configuredEndpointInventory(env, () => JSON.stringify({ providers: null }))).toBeNull()
  })
})

describe('remoteLoopbackPorts', () => {
  it('reads every endpoint of a Remote magpie on this computer’s loopback', () => {
    const json = list([
      { id: 'solis', preset: 'remote-magpie', key: 'sk-magpie-secret', anthropic: 'http://127.0.0.1:13425', chat: 'http://127.0.0.1:13425/v1', responses: 'http://localhost:13426/v1' },
      { id: 'office', preset: 'remote-magpie', chat: 'http://192.168.1.20:3425/v1' },
      { id: 'ollama', preset: 'ollama', chat: 'http://127.0.0.1:11434/v1' }
    ])
    expect(remoteLoopbackPorts(env, () => json)).toEqual([13425, 13426])
  })

  it('is empty when the list is missing, broken or of another shape', () => {
    expect(remoteLoopbackPorts(env, () => { throw new Error('ENOENT') })).toEqual([])
    expect(remoteLoopbackPorts(env, () => '{nope')).toEqual([])
    expect(remoteLoopbackPorts(env, () => JSON.stringify({ providers: 'x' }))).toEqual([])
  })

  it('tells Cookrew’s own forwarder apart from a tunnel made by hand', () => {
    const json = list([
      { id: 'solis-core', preset: 'remote-magpie', chat: 'http://127.0.0.1:3428/peer/deviceB0000000000000000000000002/v1', url: 'http://127.0.0.1:3428/peer/deviceB0000000000000000000000002' },
      { id: 'my-tunnel', preset: 'remote-magpie', chat: 'http://127.0.0.1:13425/v1' },
      // The forwarder's port, but not its path: someone else's server there.
      { id: 'squatter', preset: 'remote-magpie', chat: 'http://127.0.0.1:3428/v1' },
      // A peer path on another port is not our forwarder either.
      { id: 'other-port', preset: 'remote-magpie', chat: 'http://127.0.0.1:13426/peer/deviceB0000000000000000000000002/v1' }
    ])
    const rows = remoteLoopbackProviders(env, () => json)
    expect(rows.filter((row) => row.id === 'solis-core').every((row) => row.managed)).toBe(true)
    expect(rows.filter((row) => row.id === 'my-tunnel').every((row) => !row.managed)).toBe(true)
    expect(rows.filter((row) => row.id === 'squatter').every((row) => !row.managed)).toBe(true)
    expect(rows.filter((row) => row.id === 'other-port').every((row) => !row.managed)).toBe(true)
  })

  it('looks where Magpie keeps its settings, XDG first', () => {
    expect(providersFile(env)).toBe(path.join('/Users/x', '.config', 'magpie', 'providers.json'))
    expect(providersFile({ home: '/h', env: { XDG_CONFIG_HOME: '/xdg' } })).toBe(path.join('/xdg', 'magpie', 'providers.json'))
  })
})

describe('remoteLoopbackProviders', () => {
  it('names each loopback Remote magpie once per port, for the panel’s warning', () => {
    const json = list([
      { id: 'solis', preset: 'remote-magpie', anthropic: 'http://127.0.0.1:13425', chat: 'http://127.0.0.1:13425/v1' },
      { id: 'office', preset: 'remote-magpie', chat: 'http://192.168.1.20:3425/v1' },
      { id: 'Bad Id', preset: 'remote-magpie', chat: 'http://127.0.0.1:1/v1' }
    ])
    expect(remoteLoopbackProviders(env, () => json)).toEqual([{ id: 'solis', port: 13425, managed: false }])
  })
})

describe('plainRemoteProviders', () => {
  it('names a Remote magpie on plain http off a tailnet, and none on a tailnet, https or loopback', () => {
    const json = list([
      { id: 'office', preset: 'remote-magpie', chat: 'http://192.168.1.20:3425/v1' },
      { id: 'tail', preset: 'remote-magpie', chat: 'http://100.101.102.103:3425/v1' },
      { id: 'named', preset: 'remote-magpie', chat: 'http://mac.tail1234.ts.net:3425/v1' },
      { id: 'secure', preset: 'remote-magpie', chat: 'https://192.168.1.21:3425/v1' },
      { id: 'solis', preset: 'remote-magpie', chat: 'http://127.0.0.1:13425/v1' },
      { id: 'public', preset: 'remote-magpie', chat: 'http://gw.example.com:3425/v1' },
      { id: 'ollama', preset: 'ollama', chat: 'http://192.168.1.30:11434/v1' }
    ])
    expect(plainRemoteProviders(env, () => json, { self: [], peers: ['100.101.102.103', 'mac.tail1234.ts.net'] })).toEqual([
      { id: 'office', host: '192.168.1.20:3425' },
      { id: 'public', host: 'gw.example.com:3425' }
    ])
  })
})

