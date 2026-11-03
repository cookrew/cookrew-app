// THE SOUS AGENT PLUGIN'S CONTRACT (design §12 J4): the same shape as the
// Cookrew row (tests/route-plugin.test.ts), pointed at Sous's own file.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain JS module shipped as a resource, typed here by its test
import { agent, connect } from '../resources/magpie-sous/sous.agent.js'

const DIR = path.join(__dirname, '..', 'resources', 'magpie-sous')

describe('the Sous agent plugin for Magpie', () => {
  it('describes the row Magpie draws, pointing at the file Sous reads', () => {
    expect(agent).toEqual({
      id: 'sous',
      name: 'Cookrew Sous',
      icon: 'https://cookrew.dev/favicon.svg',
      dir: '~/.cookrew',
      config: '~/.cookrew/sous-magpie.json',
      format: 'json',
      model: 'route.model',
      ua: ['cookrew-sous'],
      notice: expect.stringContaining('Sous decides with this model')
    })
  })

  it('connect writes the four route.* keys and nothing else', () => {
    const written = connect({
      gateway: { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'sk-magpie-key-SOUS' },
      model: { id: 'group/jevs' },
      models: [],
      agent
    })
    expect(written).toEqual({
      'route.gateway': 'http://127.0.0.1:3425',
      'route.v1': 'http://127.0.0.1:3425/v1',
      'route.key': 'sk-magpie-key-SOUS',
      'route.model': 'group/jevs'
    })
  })

  it('is plain ESM with no imports, so moejs can run it', () => {
    const source = readFileSync(path.join(DIR, 'sous.agent.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/\b(fetch|setTimeout|process|fs)\b/)
  })

  it('is packaged under the community name with the agent entry, and shipped beside the Cookrew row', () => {
    const pkg = JSON.parse(readFileSync(path.join(DIR, 'package.json'), 'utf8')) as { name: string; magpie: { agent: string }; type: string }
    expect(pkg.name).toBe('@magpie-community/agent-cookrew-sous')
    expect(pkg.type).toBe('module')
    expect(pkg.magpie).toEqual({ agent: './sous.agent.js' })
    const builder = readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    expect(builder).toContain('- from: resources/magpie-sous\n    to: magpie-sous')
    expect(builder).toContain('- from: resources/magpie\n    to: magpie')
  })

  it('shares the Cookrew row\'s contract: the same four keys, different ids, files and user agents', () => {
    const cookrew = readFileSync(path.join(__dirname, '..', 'resources', 'magpie', 'cookrew.agent.js'), 'utf8')
    for (const key of ["'route.gateway'", "'route.v1'", "'route.key'", "'route.model'"]) expect(cookrew).toContain(key)
    expect(agent.id).not.toBe('cookrew')
    expect(agent.config).not.toBe('~/.cookrew/magpie.json')
    expect(agent.ua).not.toEqual(['cookrew'])
  })
})
