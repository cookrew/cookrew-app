import { describe, expect, it } from 'vitest'
import { buildStaticSite } from '../registry/src/site-static'
import { SITE_STYLE } from '../registry/src/site-shell'
import { FEATURES, PILLARS, ROADMAP, STATUS, llmsText } from '../registry/src/site-content'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DEMO, PHONE_MEDIA } from '../registry/src/site-frames'
import { CANVAS_CLIP } from '../registry/src/site-motion'

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

/** A baseline or progressive JPEG's width and height, from its SOF marker. */
const jpegSize = (file: string): [number, number] => {
  const b = readFileSync(file)
  for (let i = 2; i < b.length; ) {
    const marker = b[i + 1]!
    const len = b.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]
    i += 2 + len
  }
  throw new Error(`no size in ${file}`)
}

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

  it('the hero is one question on three devices, a composite of renders on demo data, by day and by night', () => {
    const hero = /<div class="hero">[\s\S]*?<\/figure>/.exec(home())?.[0] ?? ''
    expect(hero).toContain(`/site/${DEMO.hero.file}"`)
    expect(hero).toContain(`/site/${DEMO.hero.night!.file}"`)
    expect(hero).toContain('data-source="composite"')
    expect(hero).toContain('fetchpriority="high"')
    expect(DEMO.hero.caption).toMatch(/demo data/)
  })

  it('the clip is on the canvas page, an illustration on demo data, and not on the front page', () => {
    const canvas = pages().get('features/canvas.html') ?? ''
    expect(canvas).toContain(`/site/${CANVAS_CLIP.file}"`)
    expect(canvas).toMatch(/<figure class="shot clip illustration" data-source="illustration"><video class="v-day"[^>]*poster="/)
    expect(canvas).toContain(CANVAS_CLIP.file.replace(/\.mp4$/, '-night.mp4'))
    expect(home()).not.toContain(CANVAS_CLIP.file)
    expect(CANVAS_CLIP.caption).toMatch(/demo data/)
    expect(CANVAS_CLIP.caption).not.toMatch(/record/i)
  })

  it('every figure keeps what it is in its markup, wears no box or caption (owner 2026-11-18), and none claims to be recorded', () => {
    let seen = 0
    for (const [name, body] of pages()) {
      for (const fig of figures(body)) {
        seen += 1
        expect(fig, name).toMatch(/data-source="(illustration|composite)"/)
        expect(fig, name).not.toContain('<figcaption')
        expect(fig, name).not.toMatch(/● REC|[Rr]ecorded|captured from the running app/)
      }
      expect(body, name).not.toMatch(/Product UI on demo data · illustration|<span class="no">ILLUSTRATION<\/span>/)
    }
    expect(seen).toBeGreaterThan(5)
  })

  it('every picture has its night twin, shown at night or when the reader picks night', () => {
    for (const [key, frame] of Object.entries(DEMO)) expect(frame.night, key).toBeDefined()
    const body = home()
    expect(body).toContain('<picture class="v-day">')
    expect(body).toContain('<picture class="v-night">')
    expect(body).toMatch(/<input type="radio" name="th" id="th-auto" checked>.*id="th-day".*id="th-night"/s)
    expect(SITE_STYLE).toContain(':root:has(#th-night:checked) .v-night{display:block}')
    expect(SITE_STYLE).toContain(':root:not(:has(#th-day:checked)) .v-night{display:block}')
  })

  it('every picture is in one section of one page, never two (2026-11-17, second round)', () => {
    const seenIn = new Map<string, string>()
    // Within one language: the Chinese pages show the same pictures as their English twins.
    for (const [name, body] of [...pages()].filter(([n]) => !n.startsWith('zh/'))) {
      for (const fig of figures(body)) {
        const files = new Set([...fig.matchAll(/\/site\/(demo-[a-z-]+?)(?:-\d+|-phone)?\.(?:jpg|mp4)/g)].map((m) => m[1]))
        for (const file of files) {
          expect(seenIn.get(file), `${file} on ${name} and ${seenIn.get(file)}`).toBeUndefined()
          seenIn.set(file, name)
        }
      }
    }
    expect(seenIn.size).toBeGreaterThan(12)
  })

  it('a figure whose desktop framing is too wide for a phone carries its own phone framing', () => {
    const body = home()
    for (const key of ['hero', 'routing', 'watch', 'ops'] as const) {
      expect(DEMO[key].phone, key).toBeDefined()
      expect(body).toContain(`<source media="${PHONE_MEDIA}" srcset="`)
      expect(body).toContain(DEMO[key].file.replace(/\.jpg$/, '-phone.jpg'))
    }
    // The clip is not shown on a phone (no still in its place under a caption about twenty seconds).
    const canvas = pages().get('features/canvas.html') ?? ''
    expect(canvas).not.toContain('demo-canvas-still')
    expect(canvas).toContain(`media="not all and ${PHONE_MEDIA}"`)
    expect(SITE_STYLE).toMatch(/@media \(max-width:640px\)\{[^}]*\.feature-shots figure\.clip\{display:none\}/)
  })

  it('the pillars run everywhere, then the gateway, then the workspace (owner 2026-11-18), each showing its pictures', () => {
    expect(PILLARS.map((p) => p.id)).toEqual(['everywhere', 'gateway', 'workspace'])
    const body = home()
    expect(body.indexOf('id="everywhere"')).toBeLessThan(body.indexOf('id="gateway"'))
    expect(body).toMatch(/<span class="no">01<\/span>see and prompt everywhere/)
    for (const p of PILLARS) for (const m of p.media) {
      expect(body).toContain(DEMO[m.key].file.replace(/\.jpg$/, '-800.jpg'))
      expect(body).toContain(`/site/${DEMO[m.key].file} ${DEMO[m.key].width}w`)
    }
    expect(body).toContain('Diagram, not a screenshot.')
  })

  it('every picture the pages name is a file in the repository, at the size the pages say, with its twins', () => {
    const dir = path.join(__dirname, '..', 'registry', 'assets', 'site')
    for (const frame of Object.values(DEMO)) {
      expect(existsSync(path.join(dir, frame.file)), frame.file).toBe(true)
      for (const w of frame.twins) expect(existsSync(path.join(dir, frame.file.replace(/\.jpg$/, `-${w}.jpg`))), `${frame.file} ${w}`).toBe(true)
      if (frame.phone) expect(existsSync(path.join(dir, frame.file.replace(/\.jpg$/, '-phone.jpg'))), frame.file).toBe(true)
      expect(jpegSize(path.join(dir, frame.file)), frame.file).toEqual([frame.width, frame.height])
      // Wide enough to be sharp where it is drawn: no crop is shipped narrower than the 1170 a phone screen at ×3 asks.
      expect(frame.width, frame.file).toBeGreaterThanOrEqual(1170)
    }
    expect(existsSync(path.join(dir, CANVAS_CLIP.file))).toBe(true)
    expect(existsSync(path.join(dir, CANVAS_CLIP.poster))).toBe(true)
  })
})

describe('the site in Chinese (owner 2026-11-18)', () => {
  const files = site()
  const read = (name: string): string => {
    const body = files.get(name)
    if (typeof body !== 'string') throw new Error(`no ${name}`)
    return body
  }

  it('draws the front page and every feature page again at /zh/, in Chinese, with the same claims and labels', () => {
    const zh = read('zh/index.html')
    expect(zh).toContain('<html lang="zh-CN">')
    expect(zh).toContain('任何设备。任何 harness。任何模型。')
    expect(zh).toContain('<link rel="canonical" href="https://cookrew.dev/zh/">')
    // As many claims, each with its label, as the English page.
    const claimsIn = (html: string): string[] => [...html.matchAll(/<li class="claim" data-status="([a-z-]+)">/g)].map((m) => m[1]!)
    expect(claimsIn(zh)).toEqual(claimsIn(read('index.html')))
    expect(zh).toContain('<span class="st st-planned">规划中</span>')
    for (const f of FEATURES) expect(read(`zh/features/${f.slug}.html`)).toContain('<html lang="zh-CN">')
  })

  it('links each page to its other-language twin, for readers and for engines', () => {
    expect(read('index.html')).toContain('href="/zh/" hreflang="zh-CN"')
    expect(read('zh/index.html')).toContain('href="/" hreflang="en"')
    expect(read('zh/features/canvas.html')).toContain('href="/features/canvas" hreflang="en"')
    for (const name of ['index.html', 'zh/index.html']) {
      expect(read(name)).toContain('<link rel="alternate" hreflang="en" href="https://cookrew.dev/">')
      expect(read(name)).toContain('<link rel="alternate" hreflang="zh-CN" href="https://cookrew.dev/zh/">')
    }
    // A Chinese page keeps its links in Chinese.
    expect(read('zh/index.html')).toContain('href="/zh/features/canvas"')
    expect(read('zh/features/canvas.html')).toContain('href="/zh/#download"')
  })
})
