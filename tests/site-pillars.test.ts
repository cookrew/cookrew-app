import { describe, expect, it } from 'vitest'
import { buildStaticSite } from '../registry/src/site-static'
import { PILLARS, ROADMAP, STATUS, llmsText } from '../registry/src/site-content'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DEMO } from '../registry/src/site-frames'
import { PROMO } from '../registry/src/site-motion'

/**
 * THE FRONT PAGE KEEPS WHAT IS SHIPPED APART FROM WHAT IS NOT (2026-11-16).
 * Every pillar claim wears its status beside it; a thing that is planned,
 * tried once by hand, in beta or only on the dev branch can never read as
 * shipped. And every picture is a recording of the running app: the one
 * drawing on the page says it is a diagram.
 */

const site = (): ReadonlyMap<string, string | Uint8Array> =>
  buildStaticSite({
    release: null,
    commits: null,
    console: 'https://console.cookrew.dev',
    auth: 'https://auth.cookrew.dev',
    fonts: { 'inter.woff2': new Uint8Array([1]), 'jetbrains-mono.woff2': new Uint8Array([2]) }
  })

const home = (): string => {
  const body = site().get('index.html')
  if (typeof body !== 'string') throw new Error('no index.html')
  return body
}

const claims = PILLARS.flatMap((p) => p.claims)

describe('the pillars say where every claim stands', () => {
  it('each claim is drawn with its own status label beside it', () => {
    const body = home()
    const drawn = [...body.matchAll(/<li class="claim" data-status="([a-z-]+)"><span class="st st-([a-z-]+)">([^<]+)<\/span>/g)]
    expect(drawn).toHaveLength(claims.length)
    for (const [, status, pill, label] of drawn) {
      expect(pill).toBe(status)
      expect(label).toBe(STATUS[status as keyof typeof STATUS].label)
    }
  })

  it('the legend explains every label on the page', () => {
    const body = home()
    for (const s of Object.values(STATUS)) expect(body).toContain(s.meaning)
  })

  it('what is not built is never shipped: Cloud Workspace, other people, the official or cross-machine gateway', () => {
    const unbuilt = claims.filter((c) => /Cloud Workspace|teammates|clients|family|official|across your machines|every machine of the account/i.test(`${c.title} ${c.text}`))
    expect(unbuilt.length).toBeGreaterThanOrEqual(4)
    for (const c of unbuilt) {
      expect(c.status, c.title).toBe('planned')
    }
  })

  it('borrowing another machine’s model is the manual experiment, and says how it was done', () => {
    const borrowed = claims.filter((c) => /another machine’s/i.test(c.title))
    expect(borrowed).toHaveLength(1)
    expect(borrowed[0].status).toBe('experiment')
    expect(borrowed[0].text).toMatch(/SSH tunnel set up by hand/)
    expect(borrowed[0].text).toMatch(/12 November 2026/)
  })

  it('the watch is beta and the cross-workspace bar is in dev, never shipped', () => {
    for (const c of claims.filter((c) => /watch|wrist/i.test(`${c.title} ${c.text}`))) expect(c.status, c.title).toBe('beta')
    for (const c of claims.filter((c) => /one bar/i.test(c.title))) expect(c.status, c.title).toBe('in-dev')
  })

  it('the roadmap labels every phase, and anything not built is planned', () => {
    const body = home()
    for (const r of ROADMAP) expect(body).toContain(`<b>${r.phase}</b><span class="st st-${r.status}">`)
    for (const r of ROADMAP.filter((r) => r.items.some((i) => /Cloud Workspace|official|between workspaces/i.test(i)))) expect(r.status).toBe('planned')
  })

  it('llms.txt and the structured data carry only what is shipped: a label does not travel with a lifted sentence', () => {
    const text = llmsText()
    for (const c of claims) {
      if (c.status === 'shipped') expect(text).toContain(`- ${c.title}: ${c.text}`)
      else expect(text, c.title).not.toContain(c.text)
    }
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home())?.[1] ?? ''
    expect(jsonLd.length).toBeGreaterThan(0)
    for (const c of claims.filter((c) => c.status !== 'shipped')) expect(jsonLd, c.title).not.toContain(c.text)
  })

  it('the front page does not point at serving or selling seats while sharing waits on security work', () => {
    const body = home()
    expect(body).not.toMatch(/press SERVE|a seat cost|x402|Stripe|href="\/features\/marketplace"/)
  })

  it('nothing a reader or a crawler is pointed at describes serving, seats or the marketplace as current', () => {
    const files = site()
    const banned = /\bserv(e|ed|es|ing)\b|marketplace|\bseats?\b|\bpriced\b|minted for callers|import a team/i
    const read = (name: string): string => {
      const body = files.get(name)
      if (typeof body !== 'string') throw new Error(`no ${name}`)
      return body
    }
    expect(read('llms.txt')).not.toMatch(banned)
    expect(read('sitemap.xml')).not.toMatch(banned)
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read('index.html'))?.[1] ?? ''
    expect(jsonLd).not.toMatch(banned)
    // The pages' words, not their markup or the pictures' recorded captions of the 1 Nov interface.
    const words = (html: string): string =>
      html.replace(/<figcaption>[\s\S]*?<\/figcaption>/g, '').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ')
    for (const name of [...files.keys()].filter((n) => /^features\/.+\.html$/.test(n) && n !== 'features/marketplace.html')) {
      expect(words(read(name)), name).not.toMatch(banned)
    }
    expect(words(read('index.html'))).not.toMatch(banned)
    // The marketplace page is still built for old links: it says so to crawlers.
    expect(read('features/marketplace.html')).toContain('<meta name="robots" content="noindex">')
    expect(read('features/harnesses.html')).not.toContain('noindex')
  })
})

describe('the pictures say what they are (2026-11-17)', () => {
  const pages = (): Map<string, string> => {
    const out = new Map<string, string>()
    for (const [name, body] of site()) if (typeof body === 'string' && name.endsWith('.html')) out.set(name, body)
    return out
  }
  const figures = (html: string): string[] => [...html.matchAll(/<figure class="shot[\s\S]*?<\/figure>/g)].map((m) => m[0])

  it('no page shows a 1 Nov recording of the maintainer’s own workspace', () => {
    const old = /\/site\/(promo\.mp4|promo-poster|motion-|qa-|seq-|intro-[0-9])/
    for (const [name, body] of pages()) expect(body, name).not.toMatch(old)
  })

  it('the hero is the demo clip, and it says it is an illustration on demo data', () => {
    const body = home()
    expect(body).toContain(`/site/${PROMO.file}"`)
    expect(body).toContain(`poster="`)
    expect(body).toMatch(/<figure class="shot promo illustration" data-source="illustration">/)
    expect(PROMO.caption).toMatch(/demo data/)
    expect(PROMO.caption).not.toMatch(/record/i)
  })

  it('every figure on every page wears what it is; none claims to be recorded', () => {
    let seen = 0
    for (const [name, body] of pages()) {
      for (const fig of figures(body)) {
        seen += 1
        expect(fig, name).toMatch(/data-source="(illustration|composite)"/)
        expect(fig, name).toMatch(/Product UI on demo data · illustration|Composite of product UI renders on demo data · illustration/)
        expect(fig, name).not.toMatch(/● REC|[Rr]ecorded|captured from the running app/)
      }
    }
    expect(seen).toBeGreaterThan(5)
  })

  it('the front page shows each picture once', () => {
    const files = figures(home()).map((fig) => /src="[^"]*\/site\/([^"?]+)"/.exec(fig)?.[1])
    expect(files.every(Boolean)).toBe(true)
    expect(new Set(files).size).toBe(files.length)
  })

  it('a pillar shows its pictures, each with the sentence of what it is not when one is needed; the drawing is a diagram', () => {
    const body = home()
    for (const p of PILLARS) for (const m of p.media) {
      expect(body).toContain(DEMO[m.key].file.replace(/\.jpg$/, '-800.jpg'))
      if (m.note) expect(body).toContain(m.note.replace(/&/g, '&amp;'))
    }
    expect(PILLARS.find((p) => p.id === 'everywhere')!.media.find((m) => m.key === 'watch')!.note).toMatch(/^Beta/)
    expect(body).toContain('Diagram, not a screenshot.')
  })

  it('every picture the pages name is a file in the repository, with its small twin', () => {
    const dir = path.join(__dirname, '..', 'registry', 'assets', 'site')
    for (const frame of Object.values(DEMO)) {
      expect(existsSync(path.join(dir, frame.file)), frame.file).toBe(true)
      expect(existsSync(path.join(dir, frame.file.replace(/\.jpg$/, '-800.jpg'))), frame.file).toBe(true)
    }
    expect(existsSync(path.join(dir, PROMO.file))).toBe(true)
    expect(existsSync(path.join(dir, PROMO.poster))).toBe(true)
  })
})
