import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE WEB BUILD'S MARK.
 *
 * The page a phone or a browser opens is the renderer's own index.html, served by the
 * companion. It used to carry no icon at all: a browser tab showed a blank page glyph and
 * "add to home screen" made a screenshot of the app. These pin that the tab, the home screen
 * and the manifest all get the ink COO that `scripts/brand-ink/app-icon.mjs` stamps, and that
 * every file the page names is actually there.
 */
const root = path.resolve(__dirname, '..')
const index = readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
// The icons sit at the web root: the companion reads a first path segment as a workspace
// slug, so /brand/icon.svg would be answered "No workspace at /brand".
const publicDir = path.join(root, 'src/renderer/public')

/** Width and height out of a PNG's IHDR — no image library for two numbers. */
function pngSize(file: string): [number, number] {
  const buf = readFileSync(file)
  expect(buf.subarray(1, 4).toString('ascii'), file).toBe('PNG')
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

describe('the web build wears the ink COO', () => {
  it('names the tab icon, the iOS icon and the manifest in index.html', () => {
    expect(index).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />')
    expect(index).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />')
    expect(index).toContain('<meta name="theme-color" content="#f4efe4" />')
  })

  it('ships every file the page names, at the size each slot wants', () => {
    const want: Array<[string, [number, number] | null]> = [
      ['favicon.svg', null],
      ['apple-touch-icon.png', [180, 180]],
      ['icon-192.png', [192, 192]],
      ['icon-512.png', [512, 512]],
      ['icon-maskable-512.png', [512, 512]]
    ]
    for (const [name, size] of want) {
      const file = path.join(publicDir, name)
      expect(existsSync(file), name).toBe(true)
      if (size) expect(pngSize(file), name).toEqual(size)
    }
  })

  it('the SVG is the ink mark on paper, drawn as paths and not a bitmap', () => {
    const svg = readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8')
    expect(svg).toContain('fill="#f4efe4"')
    expect(svg).toContain('fill="#1b1814"')
    expect(svg).not.toContain('<image')
    // the brush C and the glasses: two filled paths, nothing else
    expect(svg.match(/<path /g)?.length).toBe(2)
    expect(svg).not.toContain('filter')
  })

  // brushFromLine keeps a stroke's dry tail for the bristle hairlines, and the icon draws only the
  // body: with a dry pen the last 13% of the glasses never reached the tile, so the first O stood
  // open by 130 degrees, and the C stopped short of 5 o'clock. Measured on the path itself.
  const strokePoints = (id: string): Array<[number, number]> => {
    const svg = readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8')
    const d = svg.match(new RegExp(`<path id="${id}" d="([^"]+)"`))?.[1] ?? ''
    const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    return numbers.flatMap((_, i) => (i % 2 === 0 ? [[numbers[i], numbers[i + 1]] as [number, number]] : []))
  }
  /** The degrees (clockwise from 3 o'clock) a stroke touches around the first lens, in 10 degree bins. */
  const bearings = (points: Array<[number, number]>, from: number, to: number): Set<number> =>
    new Set(
      points
        .filter(([x, y]) => Math.hypot(x - 50, y - 50) >= from && Math.hypot(x - 50, y - 50) <= to)
        .map(([x, y]) => Math.floor((((Math.atan2(y - 50, x - 50) * 180) / Math.PI + 360) % 360) / 10))
    )

  // Scheme 7 of the logo sheet (owner 2026-11-05): every icon is the C round ONE lens.
  it('is the Co: nothing is drawn where the second lens used to be', () => {
    const all = [...strokePoints('s0'), ...strokePoints('s1')]
    expect(all.filter(([x, y]) => Math.hypot(x - 76.5, y - 50) < 12)).toEqual([])
  })

  it('wears the Co on the watch too, square and opaque as the App Store wants it', () => {
    const generator = readFileSync('scripts/brand-ink/app-icon.mjs', 'utf8')
    expect(generator).toContain('AppIcon.appiconset')
    const file = path.join(root, 'watch/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png')
    expect(pngSize(file)).toEqual([1024, 1024])
    // Colour type 2 is RGB with no alpha channel.
    expect(readFileSync(file)[25]).toBe(2)
  })

  it('closes the first O: the lens is a whole ring, not an arc', () => {
    expect(bearings(strokePoints('s1'), 8, 13).size).toBe(36)
  })

  it('brings the C round to 5 o\'clock, as it was drawn', () => {
    // 5 o'clock is 60 degrees clockwise from 3: the stroke's tip lands in the 60-70 bin.
    expect(bearings(strokePoints('s0'), 15, 24).has(6)).toBe(true)
  })

  it('gives Android a maskable icon, the mark inside the circle every launcher keeps', () => {
    const manifest = JSON.parse(readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'))
    const maskable = (manifest.icons as Array<{ src: string; sizes: string; purpose: string }>).find((i) => i.purpose === 'maskable')
    expect(maskable?.sizes).toBe('512x512')
    expect(existsSync(path.join(publicDir, maskable?.src ?? 'missing')), 'maskable file').toBe(true)
    // Half the mark's box diagonal has to fit what the launcher shows. An Android
    // adaptive icon shows 72 of its 108 units: on a real phone a mark at 64% of the tile filled
    // the icon edge to edge (11-05), though it sat inside the spec's 40% circle.
    const generator = readFileSync('scripts/brand-ink/app-icon.mjs', 'utf8')
    const share = Number(generator.match(/const MASKABLE_SHARE = ([\d.]+)/)?.[1])
    const [, w, h] = generator.match(/const BOX = \{ x: [\d.]+, y: [\d.]+, w: ([\d.]+), h: ([\d.]+) \}/)?.map(Number) ?? []
    expect((share / Math.max(w, h)) * Math.hypot(w, h) * 0.5).toBeLessThanOrEqual(1 / 3)
  })

  it('the manifest stands alone as an app and points at icons that exist', () => {
    const manifest = JSON.parse(readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'))
    expect(manifest.name).toBe('Cookrew')
    // Opened from the home screen with no bars at all: Chrome's and the phone's.
    expect(manifest.display).toBe('fullscreen')
    expect(manifest.theme_color).toBe('#f4efe4')
    expect(manifest.background_color).toBe('#f4efe4')
    for (const icon of manifest.icons as Array<{ src: string }>) {
      expect(existsSync(path.join(publicDir, icon.src)), icon.src).toBe(true)
    }
  })

  // The phone's usual page is /relay/@user/desktop/<id>/ on cookrew.dev. A manifest resolves its
  // URLs against its own address, so "/" would install cookrew.dev's home page, not the Mac.
  it('keeps every address relative, so the app stays under the relay prefix it was installed from', () => {
    const manifest = JSON.parse(readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'))
    const at = 'https://cookrew.dev/relay/@me/desktop/abc/manifest.webmanifest'
    expect(new URL(manifest.start_url, at).href).toBe('https://cookrew.dev/relay/@me/desktop/abc/')
    expect(new URL(manifest.scope, at).href).toBe('https://cookrew.dev/relay/@me/desktop/abc/')
    for (const icon of manifest.icons as Array<{ src: string }>) {
      expect(new URL(icon.src, at).href.startsWith('https://cookrew.dev/relay/@me/desktop/abc/'), icon.src).toBe(true)
    }
  })

  it('asks for the manifest with the session cookie: the relay refuses anything without one', () => {
    expect(index).toMatch(/<link rel="manifest" href="[^"]+" crossorigin="use-credentials" \/>/)
  })

  it('is written by the generator, which must not put the old addresses back', () => {
    const generator = readFileSync('scripts/brand-ink/app-icon.mjs', 'utf8')
    expect(generator).toContain("display: 'fullscreen'")
    expect(generator).toContain("start_url: '.'")
    expect(generator).toContain("scope: '.'")
    expect(generator).not.toContain("src: '/icon-")
  })
})
