import { describe, expect, it } from 'vitest'
import { buildStaticSite } from '../registry/src/site-static'
import { SITE_STYLE } from '../registry/src/site-shell'
import { FEATURES, llmsText } from '../registry/src/site-content'
import { FLOW_EN, FLOW_ZH } from '../registry/src/site-flow'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DEMO, PHONE_MEDIA } from '../registry/src/site-frames'
import { CANVAS_CLIP } from '../registry/src/site-motion'

/**
 * THE FRONT PAGE, "LET YOUR TOKENS FLOW" (owner 2026-11-18). It says what Cookrew does, with no status label, legend,
 * roadmap or word of progress on any page (owner 475f4a16); its facts hold (agents and replies flow across devices,
 * one account, Magpie is yetone's MIT project, no rotation of subscriptions); and every picture is the current UI on
 * demo data, said once at the page's foot.
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

describe('the front page: three flows, no word of progress, the facts kept', () => {
  const words = (html: string): string => html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ')

  it('runs hero, three flows, the three chapters, the field, start and the last call, in English and Chinese', () => {
    const files = site()
    for (const name of ['index.html', 'zh/index.html']) {
      const body = files.get(name) as string
      const order = ['class="tf-hero"', 'id="flow"', 'id="devices"', 'id="harness"', 'id="models"', 'id="field"', 'id="start"', 'class="tf-final"'].map((m) => body.indexOf(m))
      for (const at of order) expect(at, name).toBeGreaterThan(0)
      expect([...order].sort((x, y) => x - y)).toEqual(order)
      expect(body, name).toContain('class="tf-dg tf-dg-wide"')
      expect(body, name).toContain('class="tf-dg tf-dg-tall"')
      // The old front page's grid, comparison, questions and roadmap are gone; their feature pages stay.
      expect(body, name).not.toMatch(/id="(features|compare|faq|roadmap|status|built|everywhere|gateway|workspace)"/)
    }
    expect(home()).toContain('<h1>Let your tokens <em>flow freely</em>.</h1>')
    expect((files.get('zh/index.html') as string)).toContain('<h1>让你的 token<br><em>自由流转</em>。</h1>')
    for (const f of FEATURES.filter((f) => f.slug !== 'marketplace')) expect(files.has(`features/${f.slug}.html`), f.slug).toBe(true)
  })

  it('no page a reader is pointed at says shipped, in dev, beta, planned, roadmap or not yet, in English or Chinese', () => {
    const files = site()
    const en = /\b(shipped|in dev|beta|planned|manual experiment|roadmap|not yet|not built|preview|on the dev branch)\b/i
    const zh = /已上线|开发中|规划中|手动实验|路线图|尚未|还不|还没|预览版|下一步|Beta/
    for (const [name, body] of files) {
      if (typeof body !== 'string' || !/^(zh\/)?(index|features\/(?!marketplace)[a-z-]+)\.html$/.test(name)) continue
      expect(words(body), name).not.toMatch(name.startsWith('zh/') ? zh : en)
    }
    expect(llmsText()).not.toMatch(en)
  })

  it('keeps the facts: one account, not one sign-in; agents and replies flow across devices; Magpie is yetone’s, MIT; no rotation', () => {
    for (const f of [FLOW_EN, FLOW_ZH]) {
      expect(f.models.credit).toMatch(/Magpie/)
      expect(f.models.credit).toMatch(/yetone/)
      expect(f.models.credit).toMatch(/MIT/)
    }
    expect(FLOW_EN.sub).toMatch(/^One account\./)
    expect(FLOW_ZH.sub).toMatch(/^一个账号/)
    const all = [home(), site().get('zh/index.html') as string, llmsText()].map(words).join('\n')
    expect(all).not.toMatch(/one sign-in|单点登录|一次登录/i)
    expect(all).not.toMatch(/tokens? (flow|move|travel)s? (across|between) (devices|machines)|token\s*(在|跨)设备/i)
    expect(all).not.toMatch(/rotat\w* (your |several |multiple )?(subscriptions|accounts)|轮换(订阅|账号)|多订阅轮/i)
    // The chapter on devices is about agents and replies, the one on models about the gateway.
    expect(FLOW_EN.chapters[0]!.lede).toMatch(/agent needs you/)
    expect(FLOW_EN.models.note).toMatch(/installed separately/)
  })

  it('says once, at the foot, that the pictures are the current interface on demo data', () => {
    expect(home()).toContain('<p class="tf-pictures">Pictures show Cookrew’s current interface with demo data.</p>')
    expect(site().get('zh/index.html') as string).toContain('<p class="tf-pictures">图片为 Cookrew 当前界面，使用演示数据。</p>')
    expect(home()).toContain('<p class="tf-cap">Controlling a computer’s or a phone’s screen needs the switch turned on at that machine, 15 minutes per grant.</p>')
  })

  it('llms.txt and the structured data carry the new lede and the chapters', () => {
    const text = llmsText()
    expect(text).toContain(`> ${FLOW_EN.lede}`)
    for (const c of FLOW_EN.chapters) for (const [b, t] of c.points) expect(text).toContain(`- ${b}: ${t}`)
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home())?.[1] ?? ''
    expect(jsonLd).toContain(FLOW_EN.lede)
    expect(jsonLd).toContain('"@type":"HowTo"')
    expect(home()).toContain('<title>Cookrew — let your tokens flow</title>')
    expect(site().get('zh/index.html') as string).toContain('<title>Cookrew · 让你的 token 自由流转</title>')
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
    const hero = /<section class="tf-hero">[\s\S]*?<\/figure>/.exec(home())?.[0] ?? ''
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
    // Routing and the BOARD have none: the app's night palette draws a chip in each unreadable (scripts/site-demo/assets.mjs DAY_ONLY).
    for (const [key, frame] of Object.entries(DEMO)) expect(frame.night, key)[['routing', 'board'].includes(key) ? 'toBeUndefined' : 'toBeDefined']()
    const body = home()
    expect(body).toContain('<picture class="v-day">')
    expect(body).toContain('<picture class="v-night">')
    expect(body).toMatch(/<input type="radio" name="th" id="th-auto" checked>.*id="th-day".*id="th-night"/s)
    expect(SITE_STYLE).toContain(':root:has(#th-night:checked) .v-night{display:block}')
    expect(SITE_STYLE).toContain(':root:not(:has(#th-day:checked)) .v-night{display:block}')
    // By day the twin is hidden by a rule that outranks figure.shot picture/video{display:block}, or both would show.
    expect(SITE_STYLE).toContain('figure.shot .v-night{display:none}')
  })

  it('every picture is shown once on a page (the front page and a feature page may share one)', () => {
    for (const [name, body] of [...pages()].filter(([n]) => !n.startsWith('zh/'))) {
      const seen = new Set<string>()
      for (const fig of figures(body)) {
        const files = new Set([...fig.matchAll(/\/site\/(demo-[a-z-]+?)(?:-\d+|-phone)?\.(?:jpg|mp4)/g)].map((m) => m[1]!))
        for (const file of files) {
          expect(seen.has(file), `${file} twice on ${name}`).toBe(false)
          seen.add(file)
        }
      }
    }
  })

  it('a figure whose desktop framing is too wide for a phone carries its own phone framing', () => {
    const body = home()
    for (const key of ['hero', 'routing', 'ops', 'devices'] as const) {
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

  it('the front page shows the draft’s ten pictures, each in its chapter, by day and by night', () => {
    const body = home()
    const where: [string, keyof typeof DEMO][] = [
      ['tf-hero', 'hero'], ['devices', 'devices'], ['devices', 'crewPhone'], ['devices', 'hitlPhone'], ['harness', 'agents'], ['harness', 'hitlDesk'],
      ['models', 'routing'], ['field', 'ops'], ['field', 'browserCard'], ['field', 'workspaces']
    ]
    for (const [section, key] of where) {
      const at = section === 'tf-hero' ? /<section class="tf-hero">[\s\S]*?<\/section>/.exec(body)?.[0] : new RegExp(`<section class="tf-ch" id="${section}">[\\s\\S]*?</section>`).exec(body)?.[0]
      expect(at, `${section} ${key}`).toContain(`/site/${DEMO[key].file} ${DEMO[key].width}w`)
      if (DEMO[key].night) expect(at, `${section} ${key} night`).toContain(DEMO[key].night!.file)
    }
    expect(body).not.toContain(DEMO.watch.file)
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

  it('draws the front page and every feature page again at /zh/, in Chinese, with the same chapters and pictures', () => {
    const zh = read('zh/index.html')
    expect(zh).toContain('<html lang="zh-CN">')
    expect(zh).toContain('<h1>让你的 token<br><em>自由流转</em>。</h1>')
    expect(zh).toContain('<link rel="canonical" href="https://cookrew.dev/zh/">')
    // As many points and pictures as the English page.
    const count = (html: string, re: RegExp): number => [...html.matchAll(re)].length
    expect(count(zh, /<ul class="tf-points"><li>/g)).toBe(3)
    expect(count(zh, /<figure class="shot/g)).toBe(count(read('index.html'), /<figure class="shot/g))
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
    expect(read('zh/index.html')).toContain('href="/zh/"')
    expect(read('zh/features/canvas.html')).toContain('href="/zh/#download"')
  })
})
