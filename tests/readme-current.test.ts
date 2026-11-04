import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The README is the first thing a stranger reads, and it sold a canvas for days
 * after the canvas was gone. These are the claims that went stale, held down.
 */

const ROOT = path.resolve(__dirname, '..')
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1])

describe('README', () => {
  it('sells no retired feature', () => {
    for (const retired of [/infinite canvas/i, /minimap/i, /physics cables?/i, /sticky notes?/i, /React Flow/i]) {
      expect(readme).not.toMatch(retired)
    }
  })

  it('offers the download first', () => {
    expect(readme).toContain('https://github.com/cookrew/cookrew-app/releases/latest')
    expect(readme.indexOf('releases/latest')).toBeLessThan(readme.indexOf('npm run dev'))
  })

  it('covers what ships today', () => {
    for (const section of ['Download', 'Requirements', 'The zoom view', 'Agents', 'Artifacts', 'Phone', 'The cookrew CLI']) {
      expect(headings).toContain(section)
    }
  })

  it('leaves development for last', () => {
    expect(headings.at(-1)).toBe('Development')
  })
})

describe('package.json', () => {
  it('does not describe the retired canvas either', () => {
    const { description } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { description: string }
    expect(description).not.toMatch(/infinite canvas|physics cables/i)
  })
})
