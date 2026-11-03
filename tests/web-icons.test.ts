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
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
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
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toBe('#f4efe4')
    expect(manifest.background_color).toBe('#f4efe4')
    for (const icon of manifest.icons as Array<{ src: string }>) {
      expect(existsSync(path.join(publicDir, icon.src)), icon.src).toBe(true)
    }
  })
})
