// Workspace traits: the closed words the desktop distils from the owner's
// brief, else from the project's package.json and README, and the only thing
// about the project that reaches the levels snapshot. Every file below lives in
// a fresh dir under the OS tmpdir; every word in it is invented.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLevels, type LevelsInput } from '../src/main/levels/build'
import {
  createTraitLookup,
  nodeTraitIo,
  rankTraits,
  RUN_MAX,
  scorePackage,
  scoreText,
  tokensOf,
  TRAIT_RECHECK_MS,
  traitsOf,
  type TraitIo
} from '../src/main/levels/traits'
import type { WorkspaceMeta, WorkspaceState } from '../src/shared/model'
import { TRAITS_MAX, WORKSPACE_TRAITS, type WorkspaceTrait } from '../src/shared/levels'
import { fakeDesktop } from './levels-fixture'

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-traits-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body, 'utf8')
  return dir
}

const meta = (dir: string, brief?: string): Pick<WorkspaceMeta, 'dir' | 'dirs' | 'brief'> => ({
  dir,
  dirs: [dir],
  ...(brief === undefined ? {} : { brief })
})

/** The real io, counting its stats and reads. */
function countingIo(): { io: TraitIo; reads: string[]; stats: string[] } {
  const reads: string[] = []
  const stats: string[] = []
  return {
    reads,
    stats,
    io: {
      stat: (file) => {
        stats.push(path.basename(file))
        return nodeTraitIo.stat(file)
      },
      read: (file, max) => {
        reads.push(path.basename(file))
        return nodeTraitIo.read(file, max)
      }
    }
  }
}

/** A clock the test moves by hand. */
function handClock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000
  return { now: () => at, advance: (ms) => (at += ms) }
}

/** Milliseconds `fn` takes. */
function timed(fn: () => unknown): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('tokensOf', () => {
  it('lowercases and splits camelCase, acronyms and non-alphanumerics', () => {
    expect(tokensOf('myHomeLab_v2 HTTPServer-kit')).toEqual(['my', 'home', 'lab', 'v2', 'http', 'server', 'kit'])
    expect(tokensOf('k8s/Terraform.ci')).toEqual(['k8s', 'terraform', 'ci'])
  })

  it('drops URLs before splitting, so a host never reads as a word', () => {
    expect(tokensOf('see https://example.org/team/vault?key=1 now')).toEqual(['see', 'now'])
    expect(tokensOf('mail crew@invented.dev or visit invented.org/team')).toEqual(['mail', 'or', 'visit'])
    expect(tokensOf('[docs](https://invented.dev/team) <crew@invented.org>')).toEqual(['docs'])
  })

  it('keeps a scoped package name, whose @ is no address', () => {
    expect(tokensOf('@anthropic-ai/sdk @types/react')).toEqual(['anthropic', 'ai', 'sdk', 'types', 'react'])
  })

  it('drops a run with no break past RUN_MAX: a hash or a data URL is no word', () => {
    expect(tokensOf(`docs ${'deploy'.repeat(Math.ceil(RUN_MAX / 6) + 1)} notes`)).toEqual(['docs', 'notes'])
  })

  it('stays linear on hostile text: 256 KB of runs, address soup or capitals take milliseconds', () => {
    const big = 256 * 1024
    const hostile = [
      'a'.repeat(big),
      'a@'.repeat(big / 2),
      'a.'.repeat(big / 2),
      'A'.repeat(big),
      'a://'.repeat(big / 4),
      'a@b '.repeat(big / 4),
      `${'A'.repeat(RUN_MAX - 1)} `.repeat(big / RUN_MAX),
      `${'a.'.repeat(RUN_MAX / 2 - 1)}a `.repeat(big / RUN_MAX)
    ]
    for (const text of hostile) expect(timed(() => scoreText(text))).toBeLessThan(250)
    const manifest = JSON.stringify({
      name: 'a@'.repeat(big / 4),
      description: 'x.'.repeat(big / 4),
      keywords: Array.from({ length: 5000 }, () => 'a@b.c'.repeat(20))
    })
    expect(timed(() => scorePackage(manifest))).toBeLessThan(250)
  })
})

describe('scoring', () => {
  it('matches whole words, plurals and prefixes of four letters or more', () => {
    expect(scoreText('deployments')).toEqual({ ops: 1 })
    expect(scoreText('apps apis')).toEqual({ code: 2 })
    // A short keyword is whole-word only: "uikit" is not "ui".
    expect(scoreText('uikit')).toEqual({})
    expect(scoreText('UI')).toEqual({ design: 1 })
  })

  it('reads camelCase words', () => {
    expect(traitsOf('familyRecipeBook', 3)).toEqual(['home', 'docs'])
  })

  it('does not let a false friend of a prefix score', () => {
    expect(scoreText('author authored homepage demonstrates')).toEqual({})
    // An exact keyword wins over a longer keyword's prefix: a codec is media.
    expect(scoreText('codec')).toEqual({ media: 1 })
  })

  it('weights and caps per source', () => {
    expect(scoreText('agent agent agent agent', 2, 3)).toEqual({ ai: 6 })
  })

  it('ranks strongest first and breaks ties by the closed list order', () => {
    expect(rankTraits({ team: 4, ai: 9, code: 4 })).toEqual(['ai', 'code', 'team'])
    expect(rankTraits({ team: 5, play: 5, docs: 5, code: 5 })).toEqual(['code', 'docs', 'play'])
  })

  it('returns at most TRAITS_MAX', () => {
    expect(rankTraits({ code: 9, docs: 9, home: 9, media: 9, ai: 9 })).toHaveLength(TRAITS_MAX)
  })

  it('drops weak noise: below the floor, or far below the strongest', () => {
    // One incidental hit is under the floor.
    expect(rankTraits({ media: 1 })).toEqual([])
    expect(rankTraits({ code: 6, media: 1 })).toEqual(['code'])
    // Above the floor but under a quarter of the strongest.
    expect(rankTraits({ code: 12, docs: 2 })).toEqual(['code'])
    expect(rankTraits({ code: 12, docs: 3 })).toEqual(['code', 'docs'])
  })

  it('needs a single README word to be backed up, but trusts one brief word', () => {
    expect(traitsOf('homelab', 1)).toEqual([])
    expect(traitsOf('homelab', 3)).toEqual(['home'])
  })

  it('never answers a word outside the closed list', () => {
    const noise = 'The quick brown fox audits secrets and vaults, deploys Rust, plays music, writes docs, trains an LLM'
    for (const trait of traitsOf(noise, 3)) expect(WORKSPACE_TRAITS).toContain(trait)
  })
})

describe('createTraitLookup', () => {
  it('reads the README and package.json of the primary dir', () => {
    const dir = project({
      'package.json': JSON.stringify({
        name: 'invented-photo-tool',
        description: 'Video and audio stream editing',
        keywords: ['media', 'camera'],
        dependencies: { react: '1', electron: '1' },
        scripts: { secret: 'never read' }
      }),
      'README.md': '# Invented\n\nCuts video. Built as an app with a CLI.\n'
    })
    const traits = createTraitLookup()(meta(dir))
    expect(traits).toEqual(['media', 'code'])
    // Scripts are not read: their "secret" is no signal.
    expect(traits).not.toContain('security')
  })

  it('reads only the primary dir', () => {
    const primary = project({ 'README.md': 'nothing to see' })
    const second = project({ 'README.md': 'kubernetes terraform docker deploy deploy' })
    expect(createTraitLookup()({ dir: primary, dirs: [primary, second] })).toEqual([])
  })

  it('lets a non-empty brief decide over the files', () => {
    const dir = project({ 'README.md': 'kubernetes terraform docker deploy monitoring cron infra' })
    const lookup = createTraitLookup()
    expect(lookup(meta(dir))).toEqual(['ops'])
    expect(lookup(meta(dir, 'Recipes and the garden for the family'))).toEqual(['home'])
  })

  it('falls back to the files for an empty brief, or one that says nothing', () => {
    const dir = project({ 'readme.md': 'A playground sandbox for experiments and prototypes, a demo or two.' })
    const lookup = createTraitLookup()
    expect(lookup(meta(dir, ''))).toEqual(['play'])
    expect(lookup(meta(dir, 'just some words'))).toEqual(['play'])
  })

  it('answers [] for a missing dir, unreadable files and bad JSON', () => {
    const lookup = createTraitLookup()
    expect(lookup(meta(path.join(tmpdir(), 'cookrew-traits-does-not-exist')))).toEqual([])
    expect(lookup(meta(''))).toEqual([])
    const broken = project({ 'package.json': '{ "description": "kubernetes deploy', 'README.md': '' })
    expect(lookup(meta(broken))).toEqual([])
    const throwing: TraitIo = {
      stat: () => {
        throw new Error('EACCES')
      },
      read: () => {
        throw new Error('EACCES')
      }
    }
    expect(createTraitLookup(throwing)(meta(broken))).toEqual([])
  })

  it('never lets README or package.json text out, only closed-list words', () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'sk-proj-INVENTED0123456789', description: 'token ghp_INVENTEDtoken0123' }),
      'README.md': 'API_KEY=sk-live-INVENTED987 see https://secret.example.dev/vault?token=abc password vault encryption'
    })
    const traits = createTraitLookup()(meta(dir))
    expect(traits).toEqual(['security'])
    const wire = JSON.stringify(traits)
    for (const leak of ['sk-', 'INVENTED', 'example.dev', 'ghp_', 'token']) expect(wire).not.toContain(leak)
  })

  it('reads each file once while it is unchanged: a cache hit neither re-reads nor re-scores', () => {
    const dir = project({ 'README.md': 'music video podcast film', 'package.json': '{"name":"invented-podcast"}' })
    const { io, reads } = countingIo()
    const lookup = createTraitLookup(io)
    expect(lookup(meta(dir))).toEqual(['media'])
    expect([...reads].sort()).toEqual(['README.md', 'package.json'])
    for (let i = 0; i < 5; i += 1) expect(lookup(meta(dir))).toEqual(['media'])
    expect(reads).toHaveLength(2)
  })

  it('re-reads when the mtime moves', () => {
    const dir = project({ 'README.md': 'music video podcast film!!' })
    const file = path.join(dir, 'README.md')
    const stamp = new Date('2026-01-02T03:04:05Z')
    utimesSync(file, stamp, stamp)
    const { io, reads } = countingIo()
    const clock = handClock()
    const lookup = createTraitLookup(io, clock.now)
    expect(lookup(meta(dir))).toEqual(['media'])
    const before = reads.length

    // Same length, same mtime: still the cached answer, nothing read.
    writeFileSync(file, 'kubernetes deploy infra!!!', 'utf8')
    utimesSync(file, stamp, stamp)
    clock.advance(TRAIT_RECHECK_MS)
    expect(lookup(meta(dir))).toEqual(['media'])
    expect(reads.length).toBe(before)

    const later = new Date('2026-01-02T03:04:06Z')
    utimesSync(file, later, later)
    clock.advance(TRAIT_RECHECK_MS)
    expect(lookup(meta(dir))).toEqual(['ops'])
    expect(reads.length).toBe(before + 1)
  })

  it('stats each file at most once per TRAIT_RECHECK_MS, present or not', () => {
    const dir = project({ 'README.md': 'music video podcast film' })
    const { io, stats } = countingIo()
    const clock = handClock()
    const lookup = createTraitLookup(io, clock.now)
    expect(lookup(meta(dir))).toEqual(['media'])
    // package.json (absent) and README.md; readme.md is never asked once README.md answered.
    expect([...stats].sort()).toEqual(['README.md', 'package.json'])

    for (let i = 0; i < 20; i += 1) {
      clock.advance(400)
      expect(lookup(meta(dir))).toEqual(['media'])
    }
    expect(stats).toHaveLength(2)

    // A change lands within one recheck: here the README goes and a manifest comes.
    rmSync(path.join(dir, 'README.md'))
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ description: 'kubernetes deploy infra' }), 'utf8')
    clock.advance(TRAIT_RECHECK_MS)
    expect(lookup(meta(dir))).toEqual(['ops'])
    expect(stats).toHaveLength(5)
  })
})

describe('buildLevels carries traits', () => {
  const state: WorkspaceState = { name: 'Invented', dir: '/work/x', dirs: ['/work/x'], nodes: [], connections: [] }
  const input = (traits?: LevelsInput['traits']): LevelsInput => ({
    workspaces: [
      { meta: { id: 'w1', name: 'One', dir: '/work/x', dirs: ['/work/x'], icon: '' }, state },
      { meta: { id: 'w2', name: 'Two', dir: '/work/y', dirs: ['/work/y'], icon: '' }, state }
    ],
    focusedWorkspaceId: 'w1',
    live: new Map(),
    probe: new Map(),
    ledger: new Map(),
    tuning: () => null,
    harnessOf: () => 'shell',
    memory: new Map(),
    now: 0,
    ...(traits ? { traits } : {})
  })

  it('sets traits only when there are some', () => {
    const built = buildLevels(input((m) => (m.id === 'w1' ? ['code', 'ai'] : [])))
    expect(built.workspaces[0].traits).toEqual(['code', 'ai'])
    expect('traits' in built.workspaces[1]).toBe(false)
    expect('traits' in buildLevels(input()).workspaces[0]).toBe(false)
  })

  it('keeps only closed-list words, at most TRAITS_MAX, and survives a throwing lookup', () => {
    const wild = ['code', 'sk-proj-INVENTED', 'docs', 'home', 'media'] as unknown as WorkspaceTrait[]
    expect(buildLevels(input(() => wild)).workspaces[0].traits).toEqual(['code', 'docs', 'home'])
    const throwing = (): WorkspaceTrait[] => {
      throw new Error('boom')
    }
    expect('traits' in buildLevels(input(throwing)).workspaces[0]).toBe(false)
  })

  it('places traits after the icon, so the row serialises the same way every build', () => {
    const row = buildLevels(input(() => ['play'])).workspaces[0]
    expect(Object.keys(row).slice(0, 4)).toEqual(['id', 'name', 'icon', 'traits'])
  })
})

describe('the levels service with traits', () => {
  it('serves the lookup’s traits, and an unchanged lookup is no change', () => {
    let calls = 0
    const desk = fakeDesktop({
      traits: (m) => {
        calls += 1
        return m.id === 'w1' ? ['home', 'code'] : []
      }
    })
    const first = desk.service.current()
    expect(first.snapshot.workspaces[0].traits).toEqual(['home', 'code'])
    expect('traits' in first.snapshot.workspaces[1]).toBe(false)
    expect(calls).toBe(2)

    desk.turns.emit('activity', {})
    const again = desk.service.current()
    expect(desk.service.stats()).toMatchObject({ builds: 2, rev: 1 })
    expect(again.etag).toBe(first.etag)
    desk.service.close()
  })
})
