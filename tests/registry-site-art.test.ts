import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { composeSampleArt, SAMPLE_FLEET } from '../registry/src/site-art'
import { ART_DIR, ART_MANIFEST, readSampleArt, type SampleArt } from '../registry/src/site-art-manifest'
import { sampleStage } from '../registry/src/site-strata'
import type { ShellBundle } from '../registry/src/strata-shell'

// The front page's sample fleet: three levels drawn by the real figure kit at
// the strata shell's build, shipped in its bundle beside a manifest the
// registry reads, and stepped through with radios and labels on a page that
// runs no script.

const composed = composeSampleArt()
const pictures = Object.entries(composed.files).map(([file, svg]) => ({ file, svg }))
const SAMPLE_NAMES = new Set(SAMPLE_FLEET.flatMap((m) => m.workspaces.map(([name]) => name)))

/** A shell bundle as strata-build.mjs and registry-assets.mjs leave it. */
const bundleOf = (manifest: unknown, files: Record<string, string> = composed.files): ShellBundle => ({
  version: 'test',
  index: '<!doctype html>',
  files: {
    ...Object.fromEntries(Object.entries(files).map(([file, svg]) => [file, { type: 'image/svg+xml', body: svg }])),
    [ART_MANIFEST]: { type: 'application/json', body: typeof manifest === 'string' ? manifest : JSON.stringify(manifest) }
  }
})

describe('the sample pictures', () => {
  it('are six under the shell’s assets, each named by its own content', () => {
    expect(pictures).toHaveLength(6)
    for (const p of pictures) expect(p.file).toMatch(/^assets\/art\/(machines|tables|seats)-(desk|phone)\.[0-9a-f]{12}\.svg$/)
  })

  it('come out the same on every build', () => {
    expect(Object.keys(composeSampleArt().files)).toEqual(Object.keys(composed.files))
  })

  it('carry no text but the sample’s workspace names, and nothing that runs or fetches', () => {
    for (const p of pictures) {
      const texts = [...p.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
      for (const text of texts) expect(SAMPLE_NAMES.has(text), `${p.file}: ${text}`).toBe(true)
      expect(p.svg).not.toMatch(/<script|<foreignObject|\son[a-z]+=|href="(?!#)/i)
      const used = new Set([...p.svg.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1]))
      for (const id of used) expect(p.svg, `${p.file}: #${id}`).toContain(`<symbol id="${id}"`)
    }
  })

  it('re-ink themselves on a dark page', () => {
    for (const p of pictures) expect(p.svg).toContain('@media (prefers-color-scheme:dark){.cf{color:')
  })

  it('stay inside their budgets', () => {
    for (const p of pictures) {
      const name = p.file.slice(ART_DIR.length)
      const budget = name.startsWith('machines') ? 14_000 : name.startsWith('tables') ? 7_000 : 4_000
      expect(gzipSync(p.svg).byteLength, p.file).toBeLessThan(budget)
    }
  })

  it('are tagged in the manifest with what the sample says', () => {
    const { machines, tables, seats } = composed.manifest
    expect(machines.desk.tags.map((t) => [t.name, t.waiting])).toEqual([['studio', 2], ['night-runner', 2], ['old-thinkpad', 0]])
    expect(machines.desk.tags[2].sub).toContain('offline')
    expect(tables.desk.tags.map((t) => [t.name, t.agents])).toEqual([['Monorepo', 12], ['Paper Notes', 5], ['Home Lab', 2]])
    expect(seats.desk.seats).toHaveLength(12)
    expect(seats.desk.seats.filter((s) => s.phase === 'waiting').map((s) => s.name)).toEqual(['Fern'])
    for (const s of seats.phone.seats) {
      expect(s.rect.x).toBeGreaterThanOrEqual(0)
      expect(s.rect.x + s.rect.w).toBeLessThanOrEqual(seats.phone.w)
    }
  })
})

describe('the manifest, as the registry reads it', () => {
  const { manifest } = composed
  const clone = (): SampleArt => JSON.parse(JSON.stringify(manifest)) as SampleArt

  it('reads back what the build wrote, as text or as base64', () => {
    expect(readSampleArt(bundleOf(manifest))).toEqual(manifest)
    const b64 = bundleOf(manifest)
    const files = { ...b64.files, [ART_MANIFEST]: { type: 'application/json', body: Buffer.from(JSON.stringify(manifest)).toString('base64'), encoding: 'base64' as const } }
    expect(readSampleArt({ ...b64, files })).toEqual(manifest)
  })

  it('is absent without a shell, or a shell built before the sample', () => {
    expect(readSampleArt(null)).toBeNull()
    expect(readSampleArt(undefined)).toBeNull()
    expect(readSampleArt({ version: 'v', index: 'x', files: {} })).toBeNull()
  })

  it('refuses a manifest that does not hold together', () => {
    const missing = Object.fromEntries(Object.entries(composed.files).filter(([file]) => file !== manifest.seats.phone.file))
    expect(readSampleArt(bundleOf(manifest, missing)), 'a picture the bundle lacks').toBeNull()
    const outside = clone()
    outside.machines.desk.file = 'index.html'
    expect(readSampleArt(bundleOf(outside)), 'a picture outside assets/art/').toBeNull()
    const phase = clone()
    ;(phase.seats.desk.seats[0] as { phase: string }).phase = 'dancing'
    expect(readSampleArt(bundleOf(phase)), 'a phase nobody draws').toBeNull()
    const long = clone()
    long.tables.desk.tags[0].name = 'x'.repeat(81)
    expect(readSampleArt(bundleOf(long)), 'a name past 80 characters').toBeNull()
    const nan = clone()
    ;(nan.machines.phone.tags[0].fig as { x: unknown }).x = 'left'
    expect(readSampleArt(bundleOf(nan)), 'a box that is not numbers').toBeNull()
    const empty = clone()
    empty.seats.desk.seats = []
    expect(readSampleArt(bundleOf(empty)), 'a table with no seats').toBeNull()
    expect(readSampleArt(bundleOf('{not json')), 'not JSON').toBeNull()
    expect(readSampleArt(bundleOf('[]')), 'not an object').toBeNull()
  })
})

describe('the stage', () => {
  const html = sampleStage(composed.manifest, 'lv')

  it('is four radios, level 0 checked, and no script or form', () => {
    expect(html.match(/<input class="lvr" type="radio"/g)).toHaveLength(4)
    expect(html).toContain('id="lv0" checked')
    expect(html).not.toMatch(/<script|<form|\son[a-z]+=/i)
  })

  it('points every label at a radio that exists', () => {
    const ids = new Set([...html.matchAll(/<input [^>]*id="([^"]+)"/g)].map((m) => m[1]))
    const targets = [...html.matchAll(/<label [^>]*for="([^"]+)"/g)].map((m) => m[1])
    expect(targets.length).toBeGreaterThan(12)
    for (const t of targets) expect(ids.has(t), t).toBe(true)
  })

  it('steps in through the first machine, the first table and any seat', () => {
    expect(html.match(/class="hit" for="lv1"/g)).toHaveLength(2)
    expect(html.match(/class="hit" for="lv2"/g)).toHaveLength(2)
    expect(html.match(/class="hit seat" for="lv3"/g)).toHaveLength(24)
  })

  it('shows every picture lazily from the shell, and the terminal level leads to the reader’s own fleet', () => {
    for (const p of pictures) expect(html).toContain(`src="/strata/${p.file}"`)
    expect(html.match(/loading="lazy"/g)).toHaveLength(6)
    expect(html).toContain('href="/me"')
    expect(html).not.toContain('/market')
    expect(html).toContain('Sample')
  })

  it('escapes the names it is given', () => {
    const art = JSON.parse(JSON.stringify(composed.manifest)) as SampleArt
    art.machine = '<b>x</b>'
    art.tables.desk.tags[0].name = '"><img src=x>'
    const out = sampleStage(art)
    expect(out).not.toContain('<b>x</b>')
    expect(out).not.toContain('"><img src=x>')
  })
})
