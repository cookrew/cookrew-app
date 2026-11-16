// HAND-MADE TUNNELS TO ANOTHER MAGPIE: their loopback ports are read from Magpie's
// own provider list and denied to a served sandbox. Only addresses are read.
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { providersFile, remoteLoopbackPorts } from '../src/main/route/remote-ports'

const env = { home: '/Users/x', env: {} }
const list = (providers: unknown[]): string => JSON.stringify({ providers, groups: [], order: [] })

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

  it('looks where Magpie keeps its settings, XDG first', () => {
    expect(providersFile(env)).toBe(path.join('/Users/x', '.config', 'magpie', 'providers.json'))
    expect(providersFile({ home: '/h', env: { XDG_CONFIG_HOME: '/xdg' } })).toBe(path.join('/xdg', 'magpie', 'providers.json'))
  })
})
