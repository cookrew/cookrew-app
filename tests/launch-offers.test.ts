// WHAT A NEW AGENT OF EACH HARNESS CAN START ON, read off that harness's own
// catalog on disk (owner 2026-11-01: the prompt box's tune chip for codex, pi
// and opencode too). Offering only what the harness itself lists is the rule
// the live dials already follow (pi-tuning.ts): a guessed value is a model the
// binary may not have.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexLaunchOffer, launchOfferFor, opencodeLaunchOffer, piLaunchOffer, withLaunchOffers } from '../src/main/launch-offers'
import { launchCommand } from '../src/shared/launch-tune'

const dir = (): string => mkdtempSync(path.join(tmpdir(), 'launch-offers-'))
const levels = (...efforts: string[]): { effort: string }[] => efforts.map((effort) => ({ effort }))

function codexHome(config: string, catalog: unknown, catalogName = 'models_cache.json'): string {
  const home = dir()
  writeFileSync(path.join(home, 'config.toml'), config)
  writeFileSync(path.join(home, catalogName), JSON.stringify(catalog))
  return home
}

const CODEX_CATALOG = {
  models: [
    { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
    { slug: 'gpt-6-luna', visibility: 'list', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max') },
    { slug: 'openai/gpt-5-pro', visibility: 'list', supported_reasoning_levels: levels('high') },
    { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: levels('low') }
  ]
}

describe('codex', () => {
  it("lists the catalog's visible models, and the default model's levels when none is picked", () => {
    const offer = codexLaunchOffer({ codexHome: codexHome('model = "gpt-6-luna"\nmodel_reasoning_effort = "medium"\n', CODEX_CATALOG) })
    expect(offer?.harness).toBe('codex')
    expect(offer?.model).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'openai/gpt-5-pro'])
    expect(offer?.effort).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(offer?.effortFor?.['openai/gpt-5-pro']).toEqual(['high'])
    expect(offer?.effortFor?.['gpt-6.1-sol']).toContain('ultra')
  })

  it('reads the catalog config.toml points at, before the cache', () => {
    const home = dir()
    const catalog = path.join(home, 'magpie-models.json')
    writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'group/smart', supported_reasoning_levels: levels('low', 'high') }] }))
    writeFileSync(path.join(home, 'config.toml'), `model = "group/smart"\nmodel_catalog_json = "${catalog}"\n\n[profiles.x]\nmodel = "other"\n`)
    writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(CODEX_CATALOG))
    expect(codexLaunchOffer({ codexHome: home })?.model).toEqual(['group/smart'])
  })

  it("ignores a profile's model: only the top-level one is the default", () => {
    const offer = codexLaunchOffer({ codexHome: codexHome('[profiles.fast]\nmodel = "openai/gpt-5-pro"\n', CODEX_CATALOG) })
    // No top-level model: the first listed model stands in for the default.
    expect(offer?.effort).toContain('ultra')
  })

  it('offers nothing without a readable catalog', () => {
    expect(codexLaunchOffer({ codexHome: dir() })).toBeNull()
    const home = dir()
    writeFileSync(path.join(home, 'models_cache.json'), '{torn')
    expect(codexLaunchOffer({ codexHome: home })).toBeNull()
  })

  it('becomes a command codex takes', () => {
    const offer = codexLaunchOffer({ codexHome: codexHome('model = "gpt-6-luna"\n', CODEX_CATALOG) })
    expect(launchCommand('codex', { model: 'openai/gpt-5-pro', effort: 'high' }, offer)).toBe('codex -m openai/gpt-5-pro -c model_reasoning_effort=high')
  })
})

function piAgentDir(): string {
  const agent = dir()
  writeFileSync(
    path.join(agent, 'models.json'),
    JSON.stringify({
      providers: {
        'qwen-local': { models: [{ id: 'qwen3.8-27b-q8' }] },
        ifunk: { models: [{ id: 'k3', reasoning: true }] }
      }
    })
  )
  writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'qwen-local', defaultModel: 'qwen3.8-27b-q8' }))
  return agent
}

describe('pi', () => {
  it("lists pi's own models as provider/id, with each model's thinking levels", () => {
    const offer = piLaunchOffer({ piAgentDir: piAgentDir() })
    expect(offer?.harness).toBe('pi')
    expect(offer?.model).toEqual(['qwen-local/qwen3.8-27b-q8', 'ifunk/k3'])
    // The default model has no reasoning: only `off`, as pi itself says.
    expect(offer?.effort).toEqual(['off'])
    expect(offer?.effortFor?.['ifunk/k3']).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
  })

  it('offers nothing without a catalog', () => {
    expect(piLaunchOffer({ piAgentDir: dir() })).toBeNull()
  })
})

describe('opencode', () => {
  it("lists the configured providers' models, and no effort (opencode has no flag for it)", () => {
    const config = path.join(dir(), 'opencode.json')
    writeFileSync(
      config,
      JSON.stringify({ provider: { gemini: { models: { 'gemini-2.5-pro': { name: 'Gemini' } } }, openai: { models: { 'gpt-5.2-codex': {} } } } })
    )
    const offer = opencodeLaunchOffer({ opencodeConfig: config })
    expect(offer).toEqual({ harness: 'opencode', model: ['gemini/gemini-2.5-pro', 'openai/gpt-5.2-codex'], effort: [] })
  })

  it('offers nothing without configured models', () => {
    const config = path.join(dir(), 'opencode.json')
    writeFileSync(config, JSON.stringify({ plugin: [] }))
    expect(opencodeLaunchOffer({ opencodeConfig: config })).toBeNull()
    expect(opencodeLaunchOffer({ opencodeConfig: path.join(dir(), 'missing.json') })).toBeNull()
  })
})

describe('by launch command', () => {
  it('routes each preset to its harness, and a shell or a team to nothing', () => {
    const opts = { codexHome: codexHome('model = "gpt-6-luna"\n', CODEX_CATALOG), piAgentDir: piAgentDir() }
    expect(launchOfferFor('claude --permission-mode bypassPermissions', opts)?.harness).toBe('claude')
    expect(launchOfferFor('codex', opts)?.harness).toBe('codex')
    expect(launchOfferFor('pi', opts)?.harness).toBe('pi')
    expect(launchOfferFor('/Users/x/.cookrew/bin/qwen-pi', opts)?.harness).toBe('pi')
    expect(launchOfferFor('', opts)).toBeNull()
    expect(launchOfferFor('cookrew call · Team', opts)).toBeNull()
  })
})

describe('a preset list that carries its offers', () => {
  it('reads each offer when the list is serialized, not when it is built', () => {
    let calls = 0
    const list = withLaunchOffers([{ name: 'Codex', command: 'codex' }], () => {
      calls += 1
      return { harness: 'codex', model: [`m${calls}`], effort: [] }
    })
    expect(calls).toBe(0)
    expect(JSON.parse(JSON.stringify(list))).toEqual([{ name: 'Codex', command: 'codex', launch: { harness: 'codex', model: ['m1'], effort: [] } }])
    expect(JSON.parse(JSON.stringify(list))[0].launch.model).toEqual(['m2'])
  })
})
