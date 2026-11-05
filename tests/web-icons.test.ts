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
      ['icon-512.png', [512, 512]]
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
