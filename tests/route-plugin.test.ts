// THE MAGPIE AGENT PLUGIN'S CONTRACT (design D1b). Magpie runs the file in
// moejs — no Node, no fetch, no imports — so the module must be plain ESM
// that exports `agent` and `connect`, and `connect` must return exactly the
// keys src/main/route/gateway.ts watches for in ~/.cookrew/magpie.json.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain JS module shipped as a resource, typed here by its test
import { agent, connect } from '../resources/magpie/cookrew.agent.js'

const DIR = path.join(__dirname, '..', 'resources', 'magpie')

describe('the Cookrew agent plugin for Magpie', () => {
  it('describes the row Magpie draws, pointing at the file Cookrew watches', () => {
    expect(agent).toEqual({
      id: 'cookrew',
      name: 'Cookrew',
      icon: 'https://cookrew.dev/favicon.svg',
      dir: '~/.cookrew',
      config: '~/.cookrew/magpie.json',
      format: 'json',
      model: 'route.model',
      ua: ['cookrew'],
      notice: expect.stringContaining('New cards pick this up at once')
    })
  })

  it('connect writes the four route.* keys and nothing else', () => {
    const written = connect({
      gateway: { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-cookrew' },
      model: { id: 'group/smart' },
      models: [],
      agent
    })
    expect(written).toEqual({
      'route.gateway': 'http://127.0.0.1:3425',
      'route.v1': 'http://127.0.0.1:3425/v1',
      'route.key': 'magpie-cookrew',
      'route.model': 'group/smart'
    })
  })

  it('is plain ESM with no imports, so moejs can run it', () => {
    // The header comment may name what moejs lacks; only code is checked.
    const source = readFileSync(path.join(DIR, 'cookrew.agent.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/\b(fetch|setTimeout|process|fs)\b/)
  })

  it('is packaged under the community name with the agent entry', () => {
    const pkg = JSON.parse(readFileSync(path.join(DIR, 'package.json'), 'utf8')) as { name: string; magpie: { agent: string }; type: string }
    expect(pkg.name).toBe('@magpie-community/agent-cookrew')
    expect(pkg.type).toBe('module')
    expect(pkg.magpie).toEqual({ agent: './cookrew.agent.js' })
  })
})
